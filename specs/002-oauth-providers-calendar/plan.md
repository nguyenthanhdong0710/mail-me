# Implementation Plan: Read-Only OAuth, More Mail Providers, Meeting Suggestions, Shorter Reports and AI Cost Logs

**Branch**: `002-oauth-providers-calendar` | **Date**: 2026-10-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-oauth-providers-calendar/spec.md`

## Summary

The key finding: neither Google nor Microsoft has a read-only scope for **IMAP**. OAuth over IMAP
would need full mailbox access, which is more than an app password gives. So Gmail and Microsoft
OAuth accounts read mail through the **Gmail API** (`gmail.readonly`) and **Microsoft Graph**
(`Mail.Read`), using native `fetch` and no SDKs. Both APIs return raw MIME, so the existing cleaning
and agent pipeline is reused. The `MailSource` port moves from IMAP UIDs to opaque per-source
cursors; IMAP with a password stays for every other provider, with presets for Yahoo, iCloud,
Fastmail, Zoho, GMX and AOL.

A `mail-me auth` command signs in each account: Google uses PKCE with a loopback redirect plus a
paste fallback for headless servers, and Microsoft uses the device code flow. Grants are stored as
`0600` files in `data/grants`. The email channel can send with a separate **send-only** grant
(`gmail.send` / `Mail.Send`) through the provider API, or with SMTP and a password as before. It is
optional, like Telegram.

Reports get a **brief** default style (limits enforced in code), the To/Cc recipients and the
receiving address, and an "Open original" link for Gmail and Microsoft. A new **Scheduler** agent
finds events in IMPORTANT mail; calendar invitations are parsed without AI. Plain code then builds
"Add to Google Calendar" / "Add to Outlook calendar" links and an `.ics` attachment. The assistant
never touches a calendar. Every AI call logs tokens, latency and an estimated USD cost from a
built-in price table that config can override, and each email logs its total.

## Technical Context

**Language/Version**: TypeScript (strict, ESM) on Node.js ≥ 22 LTS (unchanged)

**Primary Dependencies**: unchanged from 001 (`imapflow`, `mailparser`, `html-to-text`,
`nodemailer`, `ai` + `@ai-sdk/*`, `zod`, `better-sqlite3`, `pino`, `dotenv`). **New**: `luxon`
3.7.2 (time zones; `@types/luxon` 3.7.6 dev) and `ical.js` 2.2.1 (parsing calendar invitations).
Gmail API, Microsoft Graph and OAuth endpoints are called with native `fetch` through the existing
`HttpFetch` seam. nodemailer's `MailComposer` builds MIME for API sending.

**Storage**: SQLite (unchanged) + migration 3 (TEXT keys, opaque cursor, `cost_usd`). OAuth grants
are JSON files in `auth.grants_dir` (default `data/grants`, same Docker volume), mode `0600`.

**Testing**: Vitest. Fakes for `MailSource`, `HttpFetch` (Gmail, Graph, OAuth token endpoints),
`LlmClient`, `Clock`, `GrantStore`. Contract tests for the config schema, Scheduler schema, calendar
links/.ics, and cost logging. GreenMail e2e still covers IMAP and SMTP. A labeled Scheduler eval
script, like the 001 Gatekeeper eval.

**Target Platform**: Linux server / Docker (amd64 + arm64), unchanged. Sign-in works from any
machine with a browser.

**Project Type**: Single-project long-running service with a CLI (adds `auth`).

**Performance Goals**: unchanged (report within poll interval + 2 min). The Scheduler adds at most
one LLM call per IMPORTANT email; invitations need none.

**Constraints**: Only read-only and send-only mail scopes; no calendar scopes. No secrets
(refresh/access tokens, client secret) in logs. Telegram brief report fits in one message in
≥ 90% of cases. Upgrading from 001 must not replay or skip mail.

**Scale/Scope**: 1 user, 1–10 mailboxes across providers, ≤ 3 events per email.

No open NEEDS CLARIFICATION items; all were resolved in [research.md](./research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How the design complies | Status |
|---|---|---|
| I. Self-hosted & privacy-first | Still a single process. New outbound calls go only to the user's own mail provider (OAuth token endpoint, Gmail API / Graph) and the configured LLM. The user registers their own OAuth app, so there is no shared hosted app. Calendar links are opened by the user, not by the assistant. Recipient lists and links are part of reports already sent to opted-in channels. | ✅ |
| II. Deterministic first | Rules still run first. The invitation parser runs before the Scheduler LLM (FR-114). Calendar links, `.ics`, "Open original" links, brief-length limits and cost estimates are plain code. The Scheduler has its own provider and model. **Needs amendment**: II lists only Gatekeeper and Analyst. | ✅ after amendment |
| III. Never lose mail | Read-only scopes enforce no changes at the provider (FR-109). Opaque cursors keep the contiguous-settled-prefix rule. Revoked grants never advance the cursor, and Gmail history expiry falls back to time-based listing. Scheduler failure never blocks or downgrades a report. Migration 3 keeps cursors. | ✅ |
| IV. Untrusted input & validated output | The Scheduler prompt uses the same data/instruction separation. Strict zod schema; AI output gives local times only, and code validates zones and URLs. All new fields are escaped per channel. Link targets are built by code with host allowlists. | ✅ |
| V. Modular & testable | New ports: `TokenProvider`, `GrantStore`, `OAuthClient`, `MailSender`. Gmail and Graph adapters work over `HttpFetch`. Contract tests for every new schema. **Amendment** generalizes the "IMAP, SMTP" port list to mail access and sending. | ✅ after amendment |
| VI. Type safety & config | Strict TS. The zod schema covers presets, auth methods, grants, channels, Scheduler, timezone and prices. Startup fails with a field path and the next step (e.g. the sign-in command). | ✅ |
| VII. Simplicity & observability | No new services. Two small deps (luxon, ical.js); no Google or Microsoft SDKs. The per-call and per-email cost logs fulfil VII's "LLM cost and latency" requirement. Tokens are scrubbed from logs. | ✅ |
| Security & Privacy | Grants are secrets outside git (`data/` is ignored), `0600`, never logged. TLS everywhere (HTTPS APIs, IMAP/SMTP as before). **Amendment** adds OAuth grants and client secrets to the secrets list and requires least-privilege scopes. | ✅ after amendment |

**Gate result**: PASS. The spec flagged the constitution amendment as needed; it is applied with
this plan as **v1.2.0 (MINOR)**: Scheduler role, generalized IO ports, OAuth grants as secrets,
least-privilege scopes. See research R15.

*Post-design re-check (after Phase 1)*: still compliant. The contracts keep AI output to data
(local times, text), with every link, file and cost made by code. The data model stores no
bodies; recipients appear only inside reports, which already have retention. No Complexity Tracking
entries are needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-oauth-providers-calendar/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── config.schema.md
│   ├── mail-access.contract.md
│   ├── auth-cli.contract.md
│   ├── scheduler.contract.md
│   ├── report.contract.md
│   └── ai-usage.contract.md
├── checklists/requirements.md
└── tasks.md              # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── agents/
│   ├── llm.ts                  # + scheduler role, usage with ms/model/cost, "ai call" log
│   ├── prices.ts               # NEW built-in price table + estimateCost
│   ├── analyst.ts              # + style → prompt selection
│   ├── scheduler.ts            # NEW Scheduler agent (LLM) + normalization
│   └── prompts/
│       ├── analyst.v1.md       # detailed (unchanged)
│       ├── analyst.brief.v1.md # NEW
│       └── scheduler.v1.md     # NEW
├── auth/                       # NEW
│   ├── grants.ts               # GrantStore (atomic 0600 files)
│   ├── tokens.ts               # TokenProvider, GrantRevokedError
│   ├── google.ts               # OAuthClient: PKCE + loopback/paste
│   ├── microsoft.ts            # OAuthClient: device code
│   └── cli.ts                  # `mail-me auth` command
├── calendar/                   # NEW
│   ├── invite.ts               # ical.js invitation → DetectedEvent
│   ├── links.ts                # Google / Outlook URLs
│   └── ics.ts                  # .ics writer
├── config/
│   ├── providers.ts            # NEW presets
│   ├── schema.ts               # + provider/auth, auth, scheduler, style, timezone, prices, email oauth
│   └── load.ts                 # + preset merge, grant checks, scheduler/sender resolution
├── courier/
│   ├── report.ts               # + brief clamping, recipients, events, webLink
│   └── channels/
│       ├── email/
│       │   ├── render.ts       # + recipients, events, links, open original
│       │   ├── email-channel.ts# was smtp-channel.ts: MIME via MailComposer → MailSender
│       │   └── senders.ts      # NEW SmtpSender, GmailApiSender, GraphSender
│       └── telegram/render.ts  # + recipients, events, links, open original, shortening order
├── domain/
│   ├── ports.ts                # MailSource v2, TokenProvider, MailSender, LlmRole + scheduler
│   └── types.ts                # string keys, DetectedEvent, Report fields, LlmUsage fields
├── fetcher/
│   ├── clean.ts                # + to/cc, sentAt, calendar parts
│   ├── imap-source.ts          # adapted to cursor port
│   ├── gmail-source.ts         # NEW Gmail API source
│   ├── graph-source.ts         # NEW Microsoft Graph source
│   ├── web-link.ts             # NEW "Open original" builders + allowlist
│   └── index.ts                # NEW source factory by provider/auth
├── lib/logger.ts               # mutable secret set, token redact paths
├── orchestrator/
│   ├── pipeline.ts             # cursor port, scheduler step, cost aggregation
│   └── poller.ts               # renamed from scheduler.ts
├── store/
│   ├── migrations/index.ts     # + migration 3
│   └── sqlite-store.ts         # string keys, cursor, cost_usd
└── index.ts                    # + auth command, startup notices

scripts/eval-scheduler.ts       # NEW labeled event-detection eval
tests/
├── contract/   # config-002, scheduler, calendar-links, ai-usage, mail-sender
├── integration/# gmail-source, graph-source, oauth-refresh, brief-style, events, recipients, channels-matrix, migration-3
├── unit/       # providers, grants, tokens, web-link, ics, clamp, prices
└── fixtures/   # emails with invites (Google, Outlook/Windows TZ, cancel), multi-recipient, Bcc, events set

README.md, config.example.json, .env.example   # OAuth default, both channels optional (FR-110, FR-127)
.specify/memory/constitution.md                 # v1.2.0
```

**Structure Decision**: Keep the single-project layout from 001. New concerns get their own
folders (`auth/`, `calendar/`) behind ports in `domain/ports.ts`. The poll loop is renamed to
`orchestrator/poller.ts` so "Scheduler" means only the agent.

## Documentation Plan (FR-110, FR-127, US1-6, US6-6)

The README is the setup guide for non-developer self-hosters (constitution VI), so it is a
deliverable, not an afterthought. Each user story's docs ship in the same phase as its code. Every
command, config key and log line in the README must match the contracts.

### README.md, section by section

| Section (current) | Change | Driven by |
|---|---|---|
| Intro bullets | **Read-only** bullet now says read-only is enforced by the provider (OAuth read-only permission) for Gmail and Outlook, with no mailbox password. Add bullets: "Works with Gmail, Outlook/Microsoft 365, Yahoo, iCloud, Fastmail, Zoho, GMX, AOL or any IMAP server", "Suggests calendar events with one-click add links", "Logs the estimated AI cost of every email". Summary sentence: "short summary" wording kept, plus "who it was sent to". | US1, US2, US4, US5, US7 |
| How it works (diagram + module table) | Fetch box: `IMAP / Gmail API / Microsoft Graph (read-only)`. After the Analyst: `Scheduler (LLM, optional) or invitation parser → events`. Courier line: `Email (SMTP or Gmail/Graph send-only) and/or Telegram`. Module table adds `src/auth` (sign-in, grants), `src/calendar` (invitations, links, .ics); `src/agents` lists the Scheduler; `src/fetcher` lists the three sources. | R1, R4, R10 |
| Setup guide intro (steps list, "about 15 minutes") | New step list: 1 Choose providers and channels → 2 Get credentials → 3 Create `config.json` and `.env` → 4 **Sign in (OAuth accounts)** → 5 (Optional) Telegram chat ID → 6 Validate → 7 Run and host → 8 Check. Time estimate "about 30 minutes with OAuth app registration" (SC-103). | SC-103 |
| **New** Step 1: Choose your setup | A table that routes the reader: provider → sign-in method → which subsections to follow. Delivery: "Email only / Telegram only / both. You need at least one." | US2, US6 |
| Step 1a "A mailbox password for IMAP (and SMTP)" | **Replaced** by three subsections: **a) Gmail: register your own Google OAuth app** (create Cloud project, enable Gmail API, consent screen *External*, add scopes `gmail.readonly` (+ `gmail.send` only if you use email reports from Gmail), create a *Desktop app* client, copy client ID/secret, **set the publishing status to "In production"** to avoid 7-day expiry, explain the "unverified app" warning and how to continue). **b) Outlook / Microsoft 365: register an Entra app** (App registrations → *Personal and organizational accounts*, enable *Allow public client flows*, delegated `Mail.Read`, `User.Read` (+ `Mail.Send` only for email reports), copy the client ID; a *Microsoft 365 admin approval* sub-heading for work/school tenants). **c) Other providers: app password** (preset table with provider name, where to create an app password, and a "less safe than OAuth" note; manual settings for unknown servers). Links go only to official provider pages. No Gmail app-password step remains (US1-6). | FR-110, US1-6, US2-2, R3, R6 |
| Step 1b AI key | Add a line: the optional Scheduler can use its own (cheap) model. | FR-113 |
| Step 1c Telegram | Heading becomes "Only if you use Telegram". | FR-127 |
| **New** Step 1d "Only if you use email reports" | Choose the sending account: Gmail/Outlook with a send-only sign-in (recommended, no password), or SMTP with an app password. Explain that read and send are separate grants, and that a Telegram-only setup needs none of this. | FR-102, FR-126 |
| Step 2 config tables | Rewrite the `accounts` table: `provider`, `auth`, optional `imap` (only for passwords). Three example account blocks (Gmail OAuth, Microsoft OAuth, Yahoo password) plus "any other server". New tables for `auth` (`grants_dir`, `google`, `microsoft`), `delivery.email` (`oauth` **or** `smtp`), `ai.analyst.style`, `ai.scheduler`, `ai.prices`, `timezone`, `calendar.outlook_host`. Delivery text presents both channels equally, each block labeled by when it's needed. Reference link points to `specs/002-…/contracts/config.schema.md` (and still to 001 for unchanged keys). | FR-124, FR-127 |
| Step 2 `.env` example | OAuth setup shows only `GOOGLE_OAUTH_CLIENT_SECRET` and AI keys. Password variables are shown commented out, labeled "only for password accounts" and "only for email reports over SMTP". Note: grant files are secrets too but live in `data/grants`, not `.env`. | FR-110, FR-126 |
| **New** Step 4: Sign in | `mail-me auth <account-id>` per OAuth account and `mail-me auth --email-channel` for sending. Show Node and Docker forms (`docker compose run --rm -p 53682:53682 mail-me auth <id>`), the paste-back flow for headless servers, the Microsoft device code flow, `mail-me auth --status`, and copying `data/grants/` from a laptop to a server (keep `chmod 600`). Say what the consent screen should list, and to stop if it asks for more. | FR-103, US1-2, edge case "headless" |
| Step 3 Telegram chat ID | Unchanged; renumbered. | — |
| Step 4 Validate | `check-config` now also reports each grant's status (or the sign-in command to run). | FR-108 |
| Step 5 Run and host | Docker: set `TZ` / `timezone` (containers default to UTC). `data/` holds the database **and grants**: back it up, keep it private. Rename the cron/systemd references if the poller rename shows in log lines. | R5, R12 |
| Step 6 Check that it works | Add checks: report shows `👥 To/Cc` and "Open original" (Gmail/Outlook); an email with a meeting shows `📅` and both calendar links; `docker compose logs` shows `ai call` lines with `costUsd`. Example report updated to the brief layout. | US3, US4, US5, US7 |
| **New** "Reports" section (after Step 6) | Brief vs. detailed style with a short example of each, what the Event section means, that the assistant never writes to your calendar, and that `.ics` / links are added by you. | FR-111, FR-118 |
| **New** "AI cost" section | How to read the cost log lines, that costs are estimates from a price list dated `pricesAsOf`, and how to set `ai.prices`. | FR-123 |
| Troubleshooting | Add rows: `not signed in. Run: mail-me auth <id>`; `sign-in revoked or expired` (incl. 7-day Testing-mode expiry); `signed in as a different address`; `access_denied` / admin approval required (Microsoft 365); redirect page "can't be reached" (expected, paste the address); Microsoft + password rejected; `no price for model, cost unknown`. Change the IMAP auth row to "password accounts only". | FR-104, FR-108, US2-2 |
| Privacy | Mailboxes: read-only enforced by provider permission (OAuth) or EXAMINE/BODY.PEEK (IMAP). Grants: what's in `data/grants`, owner-only, how to revoke (Google account Security page, Microsoft account "Apps and services" / My Apps). No calendar permission is ever requested. Reports now include recipient addresses. Calendar links send event details to Google/Microsoft only when you click them. Logs include token counts and estimated cost. | FR-105, FR-118, constitution I |
| Commands | Add `auth <id>`, `auth --email-channel`, `auth --status`, `eval:scheduler`. | FR-103 |
| Development | Design docs: `specs/001-…` and `specs/002-…`. | — |
| **New** "Upgrading from 001" | Old configs still work unchanged. To switch a Gmail account from an app password: register the OAuth app, set `"provider": "gmail"`, remove the `imap` block and its `.env` password, run `auth`, then **revoke the old app password**. | US1, R2 migration |

### config.example.json

- Gmail account with `"provider": "gmail"` (OAuth, no `imap`). Examples for Microsoft and
  password providers live in the README only, since JSON has no comments (001 research R8).
- `auth` block with Google client ID placeholder and `client_secret_env`; Microsoft block present
  with a placeholder ID.
- `delivery.email` **and** `delivery.telegram` blocks both shown, both `"enabled": false` by default
  so the user must pick at least one (startup tells them if they don't). `email` uses `oauth`.
- `ai.analyst.style: "brief"`, `ai.scheduler` block (enabled, small model), `timezone`,
  `calendar.outlook_host`. No `ai.prices` (README explains it).
- No real addresses or IDs.

### .env.example

- Top: AI keys and `GOOGLE_OAUTH_CLIENT_SECRET`.
- Sections labeled `# Only if you use Telegram`, `# Only if you use email reports over SMTP (password)`,
  `# Only for password-based mail accounts (Yahoo, iCloud, …)`, all commented out.
- No Gmail app-password line.

### docker-compose.yml

- Comment showing the one-off sign-in with the published callback port.
- Comment to set `TZ` (or `timezone` in config); note that `./data` now also holds grants.

### Docs acceptance checks (go into tasks and quickstart)

- `grep -i "app password"` in README only matches the "Other providers" and "Upgrading" sections.
- Following the README alone on a fresh machine reaches a first OAuth report in < 30 minutes (SC-103).
- Telegram-only path in the README never asks for SMTP or a send grant (SC-110).
- Every config key in `config.example.json` is described in the README, and it passes `check-config`
  after filling placeholders (a contract test parses the example file).

## Implementation Order (for /speckit-tasks)

1. **Foundation**: constitution v1.2.0, migration 3 + string keys + cursor `MailSource` (IMAP
   adapted, all 001 tests green), logger secret set, poller rename.
2. **US1 + US2 (P1)**: presets and config; grants, tokens and OAuth clients; `auth` CLI; Gmail and
   Graph sources; send-only senders. Docs: README intro, How it works, Steps 1–4 (OAuth app
   registration, presets, sign-in), Troubleshooting OAuth rows, Privacy, Upgrading;
   `config.example.json`, `.env.example`, `docker-compose.yml` comments.
3. **US6, US7, US3 (P2)**: channel validation messages; recipients and web links; brief style with
   clamping. Docs: channel labels in Steps 1–2, Reports section, Step 6 checks.
4. **US4 (P2)**: invitation parser, Scheduler agent, links/.ics, renderers, eval script. Docs:
   `ai.scheduler`, `timezone`, `calendar` keys, Event section in Reports, Commands.
5. **US5 (P3)**: prices, per-call and per-email cost logs, `cost_usd`. Docs: AI cost section,
   troubleshooting row.
6. **Polish**: walk through the docs acceptance checks above against a fresh install.

## Complexity Tracking

No constitution violations to justify. The amendment (v1.2.0) is part of this feature.
