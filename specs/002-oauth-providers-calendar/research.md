# Research: Read-Only OAuth, More Providers, Meeting Suggestions, Shorter Reports, AI Cost Logs

Package versions checked on npm on 2026-10-30: luxon 3.7.2 (@types/luxon 3.7.6), ical.js 2.2.1.
Existing dependencies from feature 001 are unchanged. No Google or Microsoft SDK is added.

## R1. Read-only mailbox access for Gmail and Microsoft (the key finding)

- **Finding**: Neither provider offers a read-only scope for **IMAP**. Gmail IMAP with XOAUTH2
  requires `https://mail.google.com/` (full access, including permanent delete). Microsoft IMAP
  with OAuth requires `IMAP.AccessAsUser.All` (full read/write). Using IMAP with OAuth would ask
  for more than an app password does, which defeats FR-101 and SC-102.
- **Decision**: OAuth accounts use the providers' REST APIs, which do have read-only scopes:
  - Google: **Gmail API** with `https://www.googleapis.com/auth/gmail.readonly`.
  - Microsoft: **Microsoft Graph** with `Mail.Read` (+ `offline_access`, `User.Read`).
  Both can return the full raw message (Gmail `messages.get?format=raw`, Graph
  `/messages/{id}/$value`), so the existing `parseAndClean` pipeline is reused unchanged.
- **Rationale**: The read-only guarantee is enforced by the provider (FR-109, SC-102), not just by
  our code. Raw MIME keeps one parsing path for all providers.
- **Alternatives**: IMAP + XOAUTH2 (rejected: full-access scopes). `googleapis` / `@microsoft/microsoft-graph-client`
  SDKs (rejected: very large for the 5–6 endpoints we need; native `fetch` behind the existing
  `HttpFetch` seam is simpler and fakeable).

## R2. Generalizing the mail source (IMAP, Gmail API, Graph)

- **Decision**: The `MailSource` port moves from IMAP UIDs to an **opaque, source-defined cursor**:
  - `open(mailbox)` → `{ generation: string; head: string }`. `generation` plays the role of
    UIDVALIDITY (a change means re-baseline); `head` is the cursor for "now".
  - `fetchSince(cursor, limit)` yields messages in order, each with its own `id` and the `cursor`
    to persist once it and every earlier message are settled.
  - `cursorSince(date)` returns a cursor that makes `fetchSince` start at mail received on or
    after `date` (look-back, FR-019 of 001), or `null`.
  - `MessageKey.uidValidity` / `uid` become strings (`generation` / message id). The pipeline's
    "advance only over a contiguous prefix of settled messages" logic is unchanged.
- **Per-source cursors**:
  - IMAP: generation = UIDVALIDITY, cursor = last UID, id = UID (as decimal strings).
  - Gmail: generation = `gmail:<label id>`. Cursor `h:<historyId>@<epochMs>` uses
    `users.history.list` (`historyTypes=messageAdded,labelAdded`, `labelId=<label>`), so mail
    moved into the inbox is also seen. History IDs expire (about a week); on HTTP 404 the source
    falls back to `t:<epochMs>` mode, which lists `in:<label> after:<epochSec>` with
    `messages.list`, yields oldest-first, and switches back to `h:` mode with the head captured at
    `open()`. Look-back uses the same `t:` mode. This is how mail is not skipped after a long
    revoked-grant outage (FR-104).
  - Graph: generation = folder ID. Cursor = `receivedDateTime` (ISO) of the last settled message,
    listed with `$filter=receivedDateTime ge <cursor>&$orderby=receivedDateTime asc`. Messages at
    the boundary timestamp are re-listed and dropped by the processed check. Requests send
    `Prefer: IdType="ImmutableId"` so IDs stay stable.
- **Known limitation (documented)**: For Graph, a message moved into the folder with an older
  received time is not picked up. Graph delta queries would catch it but report every flag change
  on old mail too, which needs a baseline filter and paging state. Deferred (YAGNI); revisit if
  users hit it.
- **Rationale**: One pipeline, three adapters, no provider types leak past the port (constitution V).
- **Migration**: SQLite migration 3 rebuilds the keyed tables with `uid_validity` / `uid` as TEXT
  and `mailbox_state.last_seen_uid` → `cursor` TEXT (`CAST(... AS TEXT)` keeps existing IMAP state,
  so upgrading does not replay or skip mail).

## R3. OAuth sign-in flows and the headless server

- **Google**: "Desktop app" OAuth client, authorization-code flow with **PKCE** and a loopback
  redirect (`http://127.0.0.1:<port>`). Google's device flow does not allow Gmail scopes, so it
  cannot be used. The `auth` command starts a loopback listener **and** accepts the pasted redirect
  URL on stdin. That means the sign-in works on a laptop (automatic) and on a headless server or in
  `docker compose run` (open the printed URL anywhere, then paste the address the browser lands on,
  even though that page fails to load). Request `access_type=offline&prompt=consent` so a refresh
  token is always returned.
- **Microsoft**: public-client app registration, **device code flow** (`/devicecode` then poll
  `/token`). It is made for headless machines: the user opens `microsoft.com/devicelogin` on any
  device. Tenant defaults to `common` (personal + work); configurable for single-tenant apps.
  Error `AADSTS65001` / `AADSTS90094` (admin consent required) is turned into the "an
  administrator must approve this app" message (US2 scenario 2).
- **Confirming the account**: Google → `users.getProfile` (allowed by `gmail.readonly`; no extra
  scope). Microsoft → `/me?$select=mail,userPrincipalName` (`User.Read`, which is a profile
  permission, not a mail permission). The command refuses to save a grant whose address does not
  match the configured account.
- **Client credentials**: Google Desktop clients have a client secret that Google itself says is
  not confidential, but we still treat it as a secret (`client_secret_env`). Microsoft public
  clients have no secret. Client IDs are plain config values.
- **7-day expiry**: Google refresh tokens for apps in **Testing** publishing status expire after
  7 days. The README tells the user to set the OAuth consent screen to **In production**. For a
  personal app under 100 users this needs no Google verification; the consent screen just shows an
  "unverified app" warning, which the README explains. Expiry is reported like a revocation.
- **Alternatives**: running our own hosted OAuth app (out of scope per spec); MSAL Node (heavy, and
  its token cache format would be a second secret store).

## R4. Sending reports without passwords (send-only grant)

- **Decision**: The email channel gets two transports behind one `ReportChannel`:
  - `smtp` (password, unchanged, for any provider),
  - `oauth` — Google: Gmail API `users.messages.send` with scope `gmail.send`; Microsoft: Graph
    `POST /me/sendMail` with a base64 MIME body and scope `Mail.Send`.
  The MIME message is built once with nodemailer's `MailComposer` (already a dependency), so
  headers such as `X-Mail-Me`, `In-Reply-To` and the `.ics` attachment are identical for both
  transports.
- **Rationale**: SMTP with XOAUTH2 needs the full-access scope again (R1). `gmail.send` and
  `Mail.Send` cannot read mail, so a stolen sending grant cannot read the inbox (FR-102).
- **Separate grants**: read and send grants are separate files and separate consent screens, even
  for the same address. A monitored account never holds a send scope.

## R5. Grant storage and token refresh

- **Decision**: One JSON file per grant in `auth.grants_dir` (default `data/grants`, inside the
  existing Docker volume): `<account-id>.read.json` and `email-channel.send.json`. Written
  atomically (temp file + rename) with mode `0600`; the directory is created with `0700`.
  Startup refuses group/world-readable grant files with a fix hint (`chmod 600`).
- **Contents**: provider, address, purpose, scopes granted, refresh token, client ID it was issued
  to, created/updated times. Access tokens are kept in memory only.
- **Refresh**: refresh when the access token is within 60 s of expiry or after a 401. Microsoft
  rotates refresh tokens, so a new refresh token is written back atomically. `invalid_grant` (or
  AADSTS70008/50173/700082 etc.) → `GrantRevokedError` → the account's poll fails with "sign-in
  revoked or expired, run `mail-me auth <id>`"; other accounts continue; the cursor is not advanced.
  Network/5xx errors on the token endpoint are treated as transient mail-server errors.
- **Secrets in logs**: refresh and access tokens are never placed in log objects. Their values are
  added to the logger's scrub list as soon as they are read or refreshed (the logger scrubs a
  mutable set instead of a fixed list). `REDACT_PATHS` gains `refreshToken`, `accessToken`,
  `clientSecret`.

## R6. Provider presets

- **Decision**: A built-in table (`src/config/providers.ts`):

  | Preset | Auth methods (default first) | IMAP host | SMTP host | Web link |
  |---|---|---|---|---|
  | gmail | oauth, password | imap.gmail.com | smtp.gmail.com | yes |
  | microsoft | oauth | — (Graph) | — (Graph) | yes |
  | yahoo | password | imap.mail.yahoo.com | smtp.mail.yahoo.com | no |
  | icloud | password | imap.mail.me.com | smtp.mail.me.com (587, STARTTLS) | no |
  | fastmail | password | imap.fastmail.com | smtp.fastmail.com | no |
  | zoho | password | imap.zoho.com | smtp.zoho.com | no |
  | gmx | password | imap.gmx.com | mail.gmx.com | no |
  | aol | password | imap.aol.com | smtp.aol.com | no |
  | custom | password | (required) | (required) | no |

- **Microsoft password**: Microsoft disabled basic authentication for Outlook.com and Exchange
  Online, so the preset allows OAuth only and validation says so.
- **Regional hosts** (Zoho EU/IN, GMX .net/.de): the user overrides `imap.host`; explicit settings
  always win (FR-107).
- **Backward compatibility**: an account with no `provider` is `custom` + `password`, so every
  feature-001 config still loads. A `custom` account whose host is `imap.gmail.com` logs a hint to
  switch to `provider: "gmail"` with OAuth.
- **Rationale**: Yahoo, iCloud, Fastmail, Zoho, GMX and AOL either have no public OAuth for mail
  or restrict it to approved partners, so app passwords are the only option there (spec assumption).

## R7. "Open original" links

- **Gmail** (any access method): `https://mail.google.com/mail/u/<account email>/#search/rfc822msgid%3A<url-encoded Message-ID>`.
  It works for API and IMAP accounts, survives label changes, and `u/<email>` picks the right
  signed-in account (edge case "different account in the browser"). No link when the message has
  no Message-ID.
- **Microsoft**: the Graph message's own `webLink` property (selected in the list call). Built by
  the provider, so it opens the right mailbox and works for personal and work accounts.
- **Others**: no link (FR-129).
- **Safety**: before rendering, code accepts only `https:` URLs on `mail.google.com`,
  `outlook.office365.com`, `outlook.office.com` or `outlook.live.com`; anything else is dropped.

## R8. Recipients and receiving address

- **Decision**: `parseAndClean` also returns `to` and `cc` (from mailparser, lower-cased address,
  name stripped of control characters and capped at 64 chars) and `deliveredTo` (the account's
  configured address). A recipient is marked as "you" when `sameMailbox()` matches the account
  address. If no To/Cc entry matches, the report shows "received at <account email>" (Bcc, alias,
  forward). Empty To and Cc → "undisclosed recipients". Each list is capped at 5 with "and N more"
  (FR-128).
- **Alternatives**: trusting `Delivered-To` / `X-Original-To` headers (rejected: absent on many
  servers and can be set by senders on some; the account address is what the user configured).

## R9. Shorter reports

- **Decision**: `ai.analyst.style`: `"brief"` (default) or `"detailed"`. Two prompts:
  `analyst.brief.v1.md` (new) and the existing `analyst.v1.md` for detailed. The output schema
  stays the same (`AnalysisSchema`), so stored pending reports and both renderers keep working.
  The prompt asks for the limits, and the **Courier enforces them in code** for brief reports:
  summary cut to 2 sentences and about 40 words, at most 3 key points cut to about 15 words each,
  and the excerpt capped at 300 characters (`limits.excerpt_chars` default becomes 300 for brief
  and stays 600 for detailed when not set). The renderer shows "Action needed: No" instead of an
  empty action list (FR-112).
- **Rationale**: Prompt instructions alone do not give 100% compliance (SC-105); a deterministic
  clamp does. Keeping one schema avoids a fallback report when a model writes 4 points.

## R10. Scheduler agent (event detection)

- **Decision**: New LLM role `scheduler` with its own provider/model/enabled flag
  (`ai.scheduler`), called only for IMPORTANT emails, after the Analyst, with the same retry and
  concurrency limits. Input: the email block plus `<sent_at>` (the email's Date in ISO with offset)
  and `<user_timezone>` (IANA). Output: up to 5 candidate events with **local** date-times and an
  optional IANA zone (the model never computes offsets). Code converts to instants with Luxon,
  applies defaults (60 min duration), drops past events' links, and keeps the first 3 (FR-115).
- **Calendar invitations first (FR-114)**: if the message has a `text/calendar` part or `.ics`
  attachment, it is parsed with **ical.js** (handles `VTIMEZONE`, including Outlook's Windows zone
  names) and the Scheduler AI is not called. `METHOD:CANCEL` or `STATUS:CANCELLED` → cancelled;
  `SEQUENCE > 0` with `METHOD:REQUEST` → rescheduled.
- **File naming**: the agent lives in `src/agents/scheduler.ts`. The existing poll loop in
  `src/orchestrator/scheduler.ts` is renamed to `src/orchestrator/poller.ts` to avoid two
  different "schedulers".
- **Failure**: any Scheduler error or schema failure → log `scheduler failed`, deliver the report
  with no Event section (FR-119). It never makes the report a FALLBACK and never blocks delivery.
- **Alternatives**: one combined Analyst+Scheduler call (rejected: constitution II wants a model per
  role, and the user asked for a separate agent that can be disabled); chrono-node for date parsing
  (rejected: English-centric, and the user's mail is multilingual, e.g. Vietnamese).

## R11. Calendar links and the .ics file (plain code, FR-117)

- **Google**: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=<start>/<end>&details=…&location=…`
  with UTC `YYYYMMDDTHHMMSSZ` times, or `YYYYMMDD/YYYYMMDD` (exclusive end) for all-day events.
- **Outlook**: `https://outlook.live.com/calendar/0/action/compose?subject=…&startdt=<ISO>&enddt=<ISO>&location=…&body=…&allday=true|false`.
  `calendar.outlook_host` selects `outlook.live.com` (personal, default) or `outlook.office.com`
  (work/school, which is where Teams meetings live).
- **.ics**: generated by a small in-house writer (one `VEVENT` per event, `METHOD:PUBLISH`, UTC
  times or `VALUE=DATE` for all-day, RFC 5545 text escaping and 75-octet line folding, stable
  `UID` = hash of message key + event index). `PUBLISH` (not `REQUEST`) so calendar apps add it as
  a plain event and never send RSVPs. Attached only on the email channel, only for events that get
  links.
- **Encoding**: every value goes through `URLSearchParams` for links, the iCal text escaper for
  the file, and the channel's HTML escaper for display (FR-120). Details/body text is capped at
  500 characters so links stay under URL length limits.
- **Why not the `ics` npm package**: we need about 40 lines of output code; owning it keeps the
  escaping auditable and adds no dependency.

## R12. Time zones

- **Decision**: `timezone` (IANA, e.g. `"Asia/Ho_Chi_Minh"`) at the config root, validated with
  `Intl.supportedValuesOf("timeZone")`; default is the container's zone, and the README tells
  Docker users to set it, since containers default to UTC. Luxon handles parsing local times in a
  zone, DST, and display in the user's zone. When the email states a different zone, the event
  keeps it and the report shows the user's local time with the original zone in brackets.
- **Alternatives**: `Temporal` (not enabled by default in Node 22/24 LTS); `date-fns-tz` (fine,
  but Luxon's zone API is simpler for "local time in zone X").

## R13. AI cost estimates (FR-121–123)

- **Decision**: `LlmClient.generate` returns `usage` with `input`, `output`, `ms`, `model`,
  `provider`. A pure `estimateCost(provider, model, usage, prices)` looks up the price: config
  override first (`ai.prices["<model>"]`), then the built-in table (`src/agents/prices.ts`, with an
  `asOf` date), matching the exact model ID, then the longest built-in prefix (so dated snapshot
  IDs match their family). No match → `costUsd: null` and one `warn` per model per process.
- **Log lines**: one `ai call` line per call (role, provider, model, tokensIn, tokensOut, ms,
  costUsd), and the existing per-email line gains `tokens` (already there), `costUsd` (sum, or
  `null` if any call was unknown) and `aiCalls`. Rules-only emails log `costUsd: 0`.
  `processed_messages` gains `cost_usd REAL` so totals can be queried later.
- **Built-in prices**: filled in at implementation time from each provider's public price page
  for the models in `config.example.json` and the other current small/medium models of OpenAI,
  Anthropic and Google, with the `asOf` date in the file. The startup line logs the price-list
  date and says costs are estimates; the README says the same. Cache discounts and taxes are not
  modeled (spec assumption).

## R14. Delivery channels both optional (US6)

- **Finding**: feature 001 already validates each channel only when enabled and requires at
  least one (`deliverySchema.refine`). Remaining work: the root error message must name
  `delivery.email.enabled` / `delivery.telegram.enabled`; the email channel's sending account
  (`smtp` or `oauth`) is required only when enabled; `.env.example` stops listing `SMTP_PASSWORD`
  as a required line; README and `config.example.json` present both channels as equal, opt-in
  choices with "only if you use email reports" / "only if you use Telegram" labels; tests for the
  three combinations and the none-enabled case.

## R15. Constitution amendment (v1.1.0 → v1.2.0, MINOR)

- Principle II: LLM roles are Gatekeeper, Analyst **and Scheduler**; calendar links and files are
  built by plain code.
- Principle V: the IO ports are "mail access (IMAP or provider API), mail sending, LLM, HTTP, clock
  and storage".
- Security & Privacy: secrets include **OAuth grants (refresh tokens) and OAuth client secrets**;
  grant files are stored outside the repo with owner-only permissions; OAuth access to mailboxes
  MUST request the narrowest scope the provider offers (read-only for monitoring, send-only for
  delivery); password access is a documented fallback.
