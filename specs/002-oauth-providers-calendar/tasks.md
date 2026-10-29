---

description: "Task list for feature 002: read-only OAuth, more providers, meeting suggestions, shorter reports, AI cost logs"
---

# Tasks: Read-Only OAuth, More Mail Providers, Meeting Suggestions, Shorter Reports and AI Cost Logs

**Input**: Design documents from `/specs/002-oauth-providers-calendar/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. Constitution V requires automated tests for new behavior and contract tests
for agent and config schemas. Within each story, write tests first and see them fail.

**Organization**: Tasks are grouped by user story. Stories run in plan order: US1, US2 (P1) →
US6, US7, US3, US4 (P2) → US5 (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story the task belongs to (US1–US7 from spec.md)
- Single project: `src/`, `tests/` at repository root. Contract docs are in
  `specs/002-oauth-providers-calendar/contracts/` (referred to below as `contracts/…`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies, folders and governance.

- [X] T001 Amend `.specify/memory/constitution.md` to v1.2.0 (Scheduler role, generalized IO ports, OAuth grants as secrets, least-privilege scopes) per research R15 (done during /speckit-plan)
- [X] T002 Add exact-pinned dependencies `luxon@3.7.2`, `ical.js@2.2.1` and dev dependency `@types/luxon@3.7.6` to `package.json` and update `package-lock.json` (`npm install --save-exact`)
- [X] T003 Add npm scripts `"auth": "tsx src/index.ts auth"` and `"eval:scheduler": "tsx scripts/eval-scheduler.ts"` to `package.json`
- [X] T004 [P] Create folders `src/auth/`, `src/calendar/`, `tests/fixtures/calendar/`, `tests/fixtures/emails/brief/`, `tests/fixtures/http/` (with `.gitkeep` where empty)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cursor-based mail sources, string message keys, migration 3, presets, the generic
OAuth grant and token machinery, the `auth` command shell and the MIME-based email channel. Every
user story depends on this phase.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete and all 001 tests pass.

- [X] T005 Rename `src/orchestrator/scheduler.ts` → `src/orchestrator/poller.ts` and `tests/unit/scheduler.test.ts` → `tests/unit/poller.test.ts`; update imports in `src/index.ts` and tests (research R10: "Scheduler" now means only the agent)
- [X] T006 Change domain types in `src/domain/types.ts`: `MessageKey.uidValidity` and `MessageKey.uid` become `string` (doc comment: "IMAP UIDVALIDITY/UID, or the provider's generation / message ID"); `MailboxState` becomes `{ accountId, mailbox, uidValidity: string, cursor: string }` (drop `lastSeenUid`); `LlmUsage` gains `provider: string`, `model: string`, `ms: number`, `costUsd: number | null`; `ProcessedRecord` gains `costUsd: number | null`
- [X] T007 Change ports in `src/domain/ports.ts` per `contracts/mail-access.contract.md`: `RawMessage = { id: string; cursor: string; source: Buffer; internalDate: Date; webLink?: string }`; `MailSource.open(mailbox) → { generation: string; head: string }`, `fetchSince(cursor: string, limit)`, `cursorSince(since: Date): Promise<string | null>`; `LlmRole = "gatekeeper" | "analyst" | "scheduler"`; add `TokenProvider` (`accessToken()`, `invalidate()`), `GrantRevokedError` (`grantName`, `fixCommand`), `GrantStore` (`read(name)`, `write(name, grant)`), `OAuthClient` (`provider`, `signIn(purpose, io)`, `refresh(grant)`), `MailSender` (`send(mime, envelope)`, `verify()`), and the `Grant` type with fields from data-model.md "OAuth Grant" (`version: 1`, `provider: "google" | "microsoft"`, `purpose: "read" | "send"`, `address`, `scopes: string[]`, `clientId`, `tenant?`, `refreshToken`, `createdAt`, `updatedAt`)
- [X] T008 Add migration 3 to `src/store/migrations/index.ts` per data-model.md "Migration 3": rebuild `mailbox_state` with `uid_validity TEXT` and `cursor TEXT` (from `CAST(last_seen_uid AS TEXT)`); rebuild `processed_messages`, `pending_reports`, `deliveries` with `uid_validity TEXT`, `uid TEXT` (values via `CAST`), keeping primary keys and indexes; `ALTER TABLE processed_messages ADD COLUMN cost_usd REAL`
- [X] T009 Update `src/store/sqlite-store.ts` for string keys, `cursor`, and `cost_usd`; when reading pending reports, rebuild `report.key` from the row's columns, so 001 `report_json` with numeric keys still delivers
- [X] T010 Adapt `src/fetcher/imap-source.ts` to the cursor port: `generation = String(uidValidity)`, `head = String(uidNext - 1)`, each message `id = cursor = String(uid)`, `cursorSince(since)` = `String(firstUid - 1)` or `null`; still `readOnly: true` + BODY.PEEK
- [X] T011 Adapt `src/orchestrator/pipeline.ts` to the cursor port: baseline at `head` (or `cursorSince(now - lookback)` on first run), re-baseline when `generation` changes, persist the `cursor` of the last message in the contiguous settled prefix; build `MessageKey` from string `generation`/`id`
- [X] T012 Update `tests/fakes/index.ts` (`FakeMailServer`/`FakeMailSource` to the cursor port with string IDs; `FakeLlm` usage with `provider`, `model`, `ms`, `costUsd`), `tests/fakes/config.ts`, and every existing test that builds numeric keys, so the whole 001 suite passes (`npm test`)
- [X] T013 [P] Integration test for upgrading in `tests/integration/migration-3.test.ts`: build a v2 database with numeric state, one processed row and one pending report, run migrations, then assert the cursor is kept, the pending report delivers, and no message is replayed
- [X] T014 [P] Logger in `src/lib/logger.ts`: replace the fixed secret list with a mutable set exposed as `addSecret(value)` (ignore values shorter than 4 chars); add redact paths `refreshToken`, `accessToken`, `clientSecret`, `*.refreshToken`, `*.accessToken`, `*.clientSecret`; extend `tests/unit/logger.test.ts` (a secret added after creation is scrubbed)
- [X] T015 [P] Provider presets in `src/config/providers.ts` per research R6 / data-model.md "Mail Provider Preset": `gmail` (oauth, password; imap.gmail.com:993; smtp.gmail.com:465; webLink `gmail-msgid`), `microsoft` (oauth only; imap/smtp `null`; webLink `graph`), `yahoo`, `icloud` (smtp.mail.me.com:587 STARTTLS), `fastmail`, `zoho`, `gmx` (smtp mail.gmx.com), `aol` (password; hosts from R6; webLink `null`), `custom` (password; host required); plus `tests/unit/providers.test.ts`
- [X] T016 Config schema in `src/config/schema.ts` per `contracts/config.schema.md` "Accounts" and "Root": account `provider` (preset enum, default `"custom"`), `auth` (`"oauth" | "password"`, default = preset default, must be in the preset's `authMethods`; `microsoft` + `password` → message saying Microsoft disabled password sign-in), `imap` forbidden with `oauth`, required with `password` (`password_env` required; `host` required only for `custom`; `user` defaults to `email`); root `auth` block (`grants_dir` default `"data/grants"`, `google: { client_id, client_secret_env }`, `microsoft: { client_id, tenant default "common" }`), each required only when an account (or the email channel) uses that OAuth provider, with the message `auth.google — required because accounts[0] ("school") uses OAuth with gmail`
- [X] T017 Config loader in `src/config/load.ts`: merge preset settings under explicit settings (explicit wins, FR-107); `AccountConfig` gains `provider`, `auth`, `imap` only for password accounts, and `grant: { name: "<id>.read", provider }` for OAuth; resolve `auth.google.client_secret_env` as a secret; expose `grantsDir`
- [X] T018 Grant store in `src/auth/grants.ts`: `FileGrantStore` reads/writes `<grants_dir>/<name>.json`, creating the dir with mode `0700`, writing atomically (temp file + rename) with mode `0600`, and throwing `GrantFileError` on bad JSON, an unknown `version`, or a group/world-readable file (message includes `chmod 600 <path>`); `tests/unit/grants.test.ts`
- [X] T019 Token provider in `src/auth/tokens.ts` per research R5: one per grant; caches the access token in memory, refreshes when within 60 s of expiry or after `invalidate()`; concurrent callers share one in-flight refresh; persists a rotated refresh token via `GrantStore.write`; calls `logger.addSecret` for every token value read or received; `invalid_grant` or AADSTS70008/50173/700082 → `GrantRevokedError` with `fixCommand` (`mail-me auth <id>` or `mail-me auth --email-channel`); network/5xx → transient error; `tests/unit/tokens.test.ts`
- [X] T020 Grant startup checks (FR-108) in `src/config/load.ts` behind an option `{ checkGrants: boolean }` (default true): for each OAuth account the file `<grants_dir>/<id>.read.json` exists, is `0600`, parses, has `purpose == "read"`, `address` matching `email` via `sameMailbox`, `clientId` equal to the configured client ID, and scopes that include the required read scope and none of the blocked scopes from `contracts/mail-access.contract.md`; error messages exactly as in `contracts/config.schema.md` ("not signed in. Run: mail-me auth school", "signed in as other@…", "grant was issued to a different OAuth app")
- [X] T021 [P] Contract tests in `tests/contract/config-002.test.ts`: every 001 config still parses unchanged; preset fill-in and explicit override; `yahoo` with only `password_env`; `custom` without host rejected; `microsoft` + `password` rejected; `imap` with `oauth` rejected; missing `auth.google` rejected with the account named; each grant-check failure message from T020 (use a temp grants dir)
- [X] T022 [P] Shared JSON API helper in `src/lib/api-client.ts` over `HttpFetch` + `TokenProvider`: adds the `Authorization: Bearer` header; on 401, `invalidate()` and retry once, then throw `GrantRevokedError`; 429/5xx → transient error honoring `Retry-After`; never includes tokens in error messages; `tests/unit/api-client.test.ts`
- [X] T023 Mail source factory in `src/fetcher/index.ts`: picks the adapter by `provider` + `auth` (only `ImapMailSource` for password accounts for now; OAuth adapters are registered in US1/US2); replace `imapSourceFactory` usage in `src/index.ts`
- [X] T024 `auth` command shell in `src/auth/cli.ts` per `contracts/auth-cli.contract.md`: parse `auth <account-id>`, `--email-channel`, `--status`, `--port` (default 53682), `--listen` (default `127.0.0.1`), `--config`; load the config with `checkGrants: false`; account lookup errors ("Account \"x\" not found", "uses a password; OAuth is only for gmail and microsoft accounts", exit 2); dispatch to the provider's `OAuthClient` (registered by US1/US2); after a successful sign-in, reject a different address ("Nothing was saved") or a missing scope, then `GrantStore.write`; print the success line with the path; `--status` lists grant name, address, permission, `updatedAt`; never print tokens. Wire it into `src/index.ts` and the USAGE text
- [X] T025 Email channel refactor: rename `src/courier/channels/email/smtp-channel.ts` → `src/courier/channels/email/email-channel.ts`; build the full MIME with nodemailer `MailComposer` (same headers as `reportHeaders`, `replyTo`, html + text, optional attachments list) and send through a `MailSender`; move the SMTP transport into `SmtpSender` in `src/courier/channels/email/senders.ts` (keep `classifySmtpError`); update `src/courier/channels/index.ts` and existing tests so the 001 suite passes

**Checkpoint**: 001 behavior is unchanged on the new ports; `npm run typecheck && npm test` is green.

---

## Phase 3: User Story 1 - Gmail sign-in with read-only OAuth, no app password (Priority: P1) 🎯 MVP

**Goal**: Gmail accounts are monitored through the Gmail API with only `gmail.readonly`, signed in
once with `mail-me auth`. They renew access automatically and survive revocation without losing mail.

**Independent Test**: Fresh install, one Gmail account with `"provider": "gmail"`. The consent screen
lists read-only mail access only, `.env` has no mailbox password, and an important email produces a
report (quickstart §1).

### Tests for User Story 1

- [X] T026 [P] [US1] Recorded Gmail API responses (profile, labels, history pages with `messageAdded` and `labelAdded`, history 404, `messages.list`, `messages.get?format=raw`) as JSON in `tests/fixtures/http/gmail/`
- [X] T027 [P] [US1] Integration test for `GmailApiSource` with `FakeHttpFetch` in `tests/integration/gmail-source.test.ts`: `open` returns `generation: "gmail:INBOX"` and `head: "h:<historyId>@<ms>"`; history paging yields messages oldest first with record-ID cursors; `labelAdded` into INBOX is yielded; history 404 switches to `t:<ms>` listing and then back to `h:` at the captured head; `cursorSince` gives `t:` mode for look-back; raw base64url decodes to the exact MIME; 401 → one refresh, then `GrantRevokedError`; the source only ever sends GET requests (FR-109)
- [X] T028 [P] [US1] Unit tests for `GoogleOAuthClient` in `tests/unit/google-oauth.test.ts`: the auth URL has exactly `https://www.googleapis.com/auth/gmail.readonly` (read) or `https://www.googleapis.com/auth/gmail.send` (send), PKCE `S256`, a random `state`, `access_type=offline`, `prompt=consent`, and redirect `http://127.0.0.1:<port>/`; the loopback callback and a pasted redirect URL both complete it (first wins); a wrong `state` is rejected; the address comes from `users.getProfile`; a token response without the scope → "Read access was not granted"
- [X] T029 [P] [US1] Contract test for `GmailApiSender` in `tests/contract/mail-sender.test.ts`: `POST users/me/messages/send` with `{ raw: base64url(mime) }`; the `X-Mail-Me`, `In-Reply-To` and `References` headers survive in `raw`; a revoked grant → `ChannelError` with `retryable: true` and the text "run `mail-me auth --email-channel`"; `verify()` refreshes and sends nothing
- [X] T030 [P] [US1] Integration test in `tests/integration/oauth-revoked.test.ts`: two accounts, one with a revoked grant → it logs "sign-in revoked or expired, run mail-me auth <id>", the other account still reports, and the revoked account's cursor is unchanged; after a new grant, the email that arrived during the outage is reported exactly once (US1-5, FR-104)

### Implementation for User Story 1

- [X] T031 [US1] `GoogleOAuthClient` in `src/auth/google.ts` per research R3: PKCE code flow with the loopback listener on `<listen host>:<port>` (default `127.0.0.1`) racing a stdin paste prompt (prompt texts from `contracts/auth-cli.contract.md` "Flow: Google"); token exchange and `refresh()` at `https://oauth2.googleapis.com/token`; confirm the address via `GET gmail/v1/users/me/profile`; return a `Grant` with granted scopes
- [X] T032 [US1] `GmailApiSource` in `src/fetcher/gmail-source.ts` per research R2 and `contracts/mail-access.contract.md`, using `src/lib/api-client.ts`: label resolution (`INBOX` → `INBOX`, other names via `users.labels.list`); `h:<historyId>@<epochMs>` mode with `users.history.list?historyTypes=messageAdded&historyTypes=labelAdded&labelId=<label>`; `t:<epochMs>` mode with `users.messages.list?q=in:<label> after:<epochSec>` sorted oldest first, switching to `h:` at the head captured in `open()`; `messages.get?format=raw` → `Buffer`
- [X] T033 [US1] Register Google in the factories: `GmailApiSource` for `provider: "gmail", auth: "oauth"` in `src/fetcher/index.ts`; `GoogleOAuthClient` in `src/auth/cli.ts`; a `FileTokenProvider` per grant built in `src/index.ts`
- [X] T034 [US1] Email channel send-only OAuth: add `delivery.email.oauth: { provider: "gmail" | "microsoft", user, from? }` to `src/config/schema.ts` (exactly one of `oauth`/`smtp` when enabled); in `src/config/load.ts` resolve the grant `email-channel.send` with checks (`purpose == "send"`, send-only scopes, address == `user`; message "Run: mail-me auth --email-channel"); `GmailApiSender` in `src/courier/channels/email/senders.ts`; select the sender in `src/courier/channels/index.ts`
- [X] T035 [US1] Revoked-grant handling in `src/orchestrator/pipeline.ts` and `src/orchestrator/poller.ts`: catch `GrantRevokedError` per account, log `{ account, fix: err.fixCommand }` with "sign-in revoked or expired", keep backoff per account, never advance the cursor; the email channel maps it to a retryable `ChannelError`
- [X] T036 [US1] `check-config` in `src/index.ts` prints each OAuth grant's status (account, address, permission, last renewed) or the sign-in command to run
- [X] T037 [US1] README per plan.md "Documentation Plan": rewrite the intro bullets and the "How it works" diagram and module table; new setup step list (≈30 minutes); new "Step 1: Choose your setup"; replace Step 1a with "Gmail: register your own Google OAuth app" (Gmail API, External consent screen, scopes `gmail.readonly` (+ `gmail.send` only for email reports), Desktop app client, **publishing status "In production"** to avoid 7-day expiry, the "unverified app" warning); new "Only if you use email reports" sending-account section; new "Sign in" step (Node and `docker compose run --rm -p 127.0.0.1:53682:53682 mail-me auth <id> --listen 0.0.0.0`, paste-back, `auth --status`, copying `data/grants/` with `chmod 600`); OAuth troubleshooting rows (not signed in, revoked/expired incl. Testing mode, different address, redirect page can't be reached); Privacy (grants, revoking access, no calendar permission); "Upgrading from 001" (switch Gmail from app password, then revoke it) in `README.md`
- [X] T038 [P] [US1] Update `config.example.json` (Gmail account `"provider": "gmail"` with no `imap`, `auth` block with placeholder Google and Microsoft client IDs and `client_secret_env`, `delivery.email.oauth`), `.env.example` (`GOOGLE_OAUTH_CLIENT_SECRET` and AI keys at the top, no Gmail app-password line) and `docker-compose.yml` (comments for the sign-in command with the published port, and that `./data` holds grants)
- [X] T039 [P] [US1] Contract test in `tests/contract/config-example.test.ts`: `config.example.json` parses against the schema after the test sets `delivery.telegram.enabled = true` (the shipped example enables no channel on purpose), with `checkGrants: false` and placeholder env values

**Checkpoint**: A Gmail-only install works end to end with OAuth and no password (SC-101 for Gmail).

---

## Phase 4: User Story 2 - Outlook and many other mail providers (Priority: P1)

**Goal**: Microsoft accounts through Graph with `Mail.Read`; every preset provider and any IMAP server
with a password fallback.

**Independent Test**: One Outlook.com account (OAuth) and one Yahoo account (password) at the same
time; an important email to each produces a report labeled with its account (quickstart §2).

### Tests for User Story 2

- [X] T040 [P] [US2] Recorded Graph responses (folder, message list pages, `$value` MIME, 403 admin-consent error, device code + token responses incl. `authorization_pending`, `slow_down`, `AADSTS65001`) in `tests/fixtures/http/graph/`
- [X] T041 [P] [US2] Integration test for `GraphMailSource` in `tests/integration/graph-source.test.ts`: `Prefer: IdType="ImmutableId"` on every request; `INBOX` maps to the well-known `inbox` folder; `generation` = folder ID; list query uses `$filter=receivedDateTime ge <cursor>&$orderby=receivedDateTime asc&$select=id,receivedDateTime,webLink`; boundary-timestamp messages are re-listed and skipped as processed; `$value` gives the MIME; `webLink` is passed on `RawMessage`; only GET requests
- [X] T042 [P] [US2] Unit tests for `MicrosoftOAuthClient` in `tests/unit/microsoft-oauth.test.ts`: device code request with exactly `offline_access User.Read Mail.Read` (read) or `offline_access User.Read Mail.Send` (send) for the configured `tenant`; polling handles `authorization_pending`, `slow_down` and expiry; `AADSTS65001`/`AADSTS90094` → the admin-approval message with the client ID; the address comes from `/me?$select=mail,userPrincipalName`; a rotated refresh token is returned from `refresh()`
- [X] T043 [P] [US2] Add `GraphSender` cases to `tests/contract/mail-sender.test.ts`: `POST /me/sendMail` with `Content-Type: text/plain` and a base64 MIME body; a 202 response → `externalId` = our Message-ID; a revoked grant → retryable `ChannelError`
- [X] T044 [P] [US2] Integration test in `tests/integration/multi-provider.test.ts`: a fake Graph account and a fake IMAP `yahoo` account each produce a report labeled with their account; the password notice is logged once per password account at startup (US2-5); a `custom` account on `imap.gmail.com` logs the switch-to-OAuth hint

### Implementation for User Story 2

- [X] T045 [US2] `MicrosoftOAuthClient` in `src/auth/microsoft.ts` per research R3: device code flow on `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/{devicecode,token}` with the prompt text from `contracts/auth-cli.contract.md` "Flow: Microsoft"; `refresh()` returns the rotated refresh token; admin-consent error mapping
- [X] T046 [US2] `GraphMailSource` in `src/fetcher/graph-source.ts` per research R2 using `src/lib/api-client.ts`: folder resolution, `head` = current time ISO, `cursorSince(since)` = `since` ISO, paged listing with `$top=50` following `@odata.nextLink`, `GET /me/messages/{id}/$value`; cursor = message `receivedDateTime`
- [X] T047 [US2] Register Microsoft: `GraphMailSource` for `provider: "microsoft"` in `src/fetcher/index.ts`; `MicrosoftOAuthClient` in `src/auth/cli.ts`; `GraphSender` in `src/courier/channels/email/senders.ts` selected for `delivery.email.oauth.provider: "microsoft"`
- [X] T048 [US2] Startup notices in `src/index.ts`: one `info` per password account ("account \"yahoo\" uses a password, which is less safe than OAuth", FR-106); the `custom` + `imap.gmail.com` hint
- [X] T049 [US2] `delivery.email.smtp.provider` (optional preset) in `src/config/schema.ts` and `src/config/load.ts`, so `host/port/secure` can come from the preset
- [X] T050 [US2] README: "Outlook / Microsoft 365: register an Entra app" (Personal and organizational accounts, "Allow public client flows", delegated `Mail.Read`, `User.Read` (+ `Mail.Send` only for email reports), copy the client ID; a "Microsoft 365 admin approval" subsection); "Other providers: app password" with the preset table and a "less safe than OAuth" note; Step 2 account examples (Gmail OAuth, Microsoft OAuth, Yahoo password, any other server) and tables for `provider`, `auth`, `imap`, `auth.*`; troubleshooting rows for admin approval and Microsoft + password, and the IMAP auth row relabeled "password accounts only" in `README.md`

**Checkpoint**: Gmail, Outlook and password providers work side by side (SC-101, SC-104).

---

## Phase 5: User Story 6 - Choose delivery channels freely (Priority: P2)

**Goal**: Email and Telegram are each optional, at least one is required, and a Telegram-only
install has no sending credential.

**Independent Test**: Email-only, Telegram-only and both each deliver to exactly their channels;
neither refuses to start (quickstart §3).

### Tests for User Story 6

- [X] T051 [P] [US6] Extend `tests/contract/config-delivery.test.ts`: all three combinations valid; neither → `delivery — enable at least one channel: set delivery.email.enabled or delivery.telegram.enabled to true`; a disabled channel with missing or incomplete settings is not reported; an enabled email channel with both or neither of `oauth`/`smtp` is rejected
- [X] T052 [P] [US6] Integration test in `tests/integration/channels-matrix.test.ts`: a Telegram-only config with no `delivery.email` block and no SMTP variables loads, builds only the Telegram channel, and delivers a report; no sending secret is resolved (SC-110)

### Implementation for User Story 6

- [X] T053 [US6] In `src/config/schema.ts`, change the none-enabled message to the exact text in T051, and check `oauth`/`smtp` exclusivity only when `enabled` is true
- [X] T054 [US6] Docs: in `README.md` label the steps "Only if you use Telegram" / "Only if you use email reports" and present both channels as equal choices in Step 1 and the Step 2 delivery table; in `config.example.json` show both channel blocks with `"enabled": false`; in `.env.example` comment out and label `# Only if you use Telegram` and `# Only if you use email reports over SMTP (password)`

**Checkpoint**: Channel choice is free and documented (FR-125–127).

---

## Phase 6: User Story 7 - See who the email was sent to and open the original (Priority: P2)

**Goal**: Each report shows the To/Cc recipients, the receiving monitored address, and an
"Open original" link for Gmail and Microsoft.

**Independent Test**: Email to a monitored Gmail with two To and one Cc, plus a Bcc email: the
recipients and receiving address are right, and "Open original" opens the message (quickstart §7).

### Tests for User Story 7

- [X] T055 [P] [US7] Fixtures `tests/fixtures/emails/multi-recipient.eml` (7 To, 1 Cc, a name containing `<b>` and "ignore previous instructions"), `bcc.eml` (monitored address not in To/Cc), `undisclosed.eml` (empty To)
- [X] T056 [P] [US7] Extend `tests/unit/clean.test.ts`: `to`/`cc` are parsed with lower-cased addresses; names have control characters removed and are capped at 64 chars; `sentAt` keeps the original offset
- [X] T057 [P] [US7] Unit tests in `tests/unit/web-link.test.ts`: Gmail link `https://mail.google.com/mail/u/<email>/#search/rfc822msgid%3A<encoded Message-ID>`; no Message-ID → `null`; a Graph `webLink` on an allowed host is kept; any other host or a non-`https:` scheme → `null`; IMAP non-Gmail providers → `null`
- [X] T058 [P] [US7] Render tests in `tests/unit/recipients-render.test.ts` for both channels: at most 5 per list then "and N more"; the monitored address shown as "you"; "received at <address>" when not in To/Cc; "undisclosed recipients"; markup in names is escaped; "Open original" present only with a `webLink`; a 001 pending report without the new fields still renders

### Implementation for User Story 7

- [X] T059 [US7] Extend `src/fetcher/clean.ts` (`CleanedEmail`) with `to`, `cc`, `sentAt`; extend `IncomingEmail` in `src/domain/types.ts` with `to`, `cc`, `deliveredTo`, `addressedToYou`, `webLink: string | null`, `sentAt`
- [X] T060 [US7] "Open original" builders and host allowlist (`mail.google.com`, `outlook.office365.com`, `outlook.office.com`, `outlook.live.com`; `https:` only) in `src/fetcher/web-link.ts`; set `email.webLink` in `src/orchestrator/pipeline.ts` from the account preset's `webLink` kind and `RawMessage.webLink`; set `deliveredTo` = account email and `addressedToYou` via `sameMailbox`
- [X] T061 [US7] `Report.original` gains `to` and `cc` as `{ shown: Address[]; more: number }` (cap 5), `deliveredTo`, `addressedToYou` and `webLink` in `src/domain/types.ts`; fill them in `buildReport` in `src/courier/report.ts`
- [X] T062 [P] [US7] Email renderer `src/courier/channels/email/render.ts`: the `👥` recipients line (see `contracts/report.contract.md` layout) and the "Open original" link, HTML-escaped / attribute-escaped; missing fields → omitted
- [X] T063 [P] [US7] Telegram renderer `src/courier/channels/telegram/render.ts`: the same recipients line and an `<a href>` "Open original" with `"` escaped; missing fields → omitted
- [X] T064 [US7] Update `testReport()` in `src/index.ts` (check-delivery) with sample recipients and no link
- [X] T065 [US7] README Step 6 "Check that it works": add the recipients and "Open original" checks in `README.md`

**Checkpoint**: Recipients and links appear in every report (SC-111, SC-112).

---

## Phase 7: User Story 3 - Shorter reports (Priority: P2)

**Goal**: "brief" style by default, with limits enforced in code; "detailed" keeps the 001 format.

**Independent Test**: 20 fixed important emails through both styles; every brief report meets the
limits and "detailed" matches today's length (quickstart §4).

### Tests for User Story 3

- [X] T066 [P] [US3] 20 important `.eml` fixtures in `tests/fixtures/emails/brief/` (long threads, no-action notices, Vietnamese, one very long subject) with a matching over-long fake Analyst output for each in `tests/fixtures/emails/brief/analysis.json`
- [X] T067 [P] [US3] Unit tests in `tests/unit/clamp.test.ts`: TL;DR cut to ≤ 2 sentences and ≤ 40 words with `…`; ≤ 3 key points, each ≤ 15 words; the character fallback for text without spaces (120 chars per point, 240 for the TL;DR); the excerpt ≤ min(`excerpt_chars`, 300) chars
- [X] T068 [P] [US3] Integration test in `tests/integration/brief-style.test.ts`: every brief report from the 20 fixtures meets the limits (SC-105); reports with no actions show "Action needed: No" and no action section (FR-112); ≥ 90% of Telegram renders are one message; `style: "detailed"` uses `analyst.v1` and no clamping

### Implementation for User Story 3

- [X] T069 [P] [US3] Prompt `src/agents/prompts/analyst.brief.v1.md`: same security rules and JSON shape as `analyst.v1.md`, asking for a TL;DR of at most 2 sentences (~40 words), at most 3 one-line key points (~15 words), action items only when present
- [X] T070 [US3] Config: `ai.analyst.style` (`"brief"` default | `"detailed"`) in `src/config/schema.ts`; the brief excerpt cap is min(`limits.excerpt_chars`, 300), so 001 configs with `excerpt_chars: 600` still get short excerpts
- [X] T071 [US3] `src/agents/analyst.ts`: pick `analyst.brief.v1` or `analyst.v1` by style
- [X] T072 [US3] `src/courier/report.ts`: `Report.style`; in brief style apply the clamps tested in T067 (in `src/courier/clamp.ts`)
- [X] T073 [US3] Renderers `src/courier/channels/email/render.ts` and `src/courier/channels/telegram/render.ts`: brief layout from `contracts/report.contract.md`, and an "Action needed: No" line when there are no action items in **both** styles (FR-112)
- [X] T074 [US3] README: new "Reports" section explaining brief vs. detailed, with a short example of each, and the `ai.analyst.style` key in the Step 2 tables in `README.md`

**Checkpoint**: Reports are short by default (SC-105).

---

## Phase 8: User Story 4 - Meeting and plan suggestions with one-click "add to calendar" (Priority: P2)

**Goal**: The Scheduler agent (or the invitation parser) finds up to 3 events. Plain code builds
Google/Outlook links and an `.ics`. Nothing is ever written to a calendar.

**Independent Test**: An important email "Project sync on Thursday 6 Nov at 14:00 for 45 minutes,
Teams link: …" shows the event, and both links open a correct prefilled event (quickstart §5).

### Tests for User Story 4

- [X] T075 [P] [US4] Calendar fixtures in `tests/fixtures/calendar/`: `google-invite.eml`, `outlook-invite-windows-tz.eml` (Windows zone `VTIMEZONE`, Teams URL in `X-MICROSOFT-SKYPETEAMSMEETINGURL`), `cancel.eml` (`METHOD:CANCEL`), `rescheduled.eml` (`SEQUENCE:1`), `meeting-teams.eml` (plain text, no invite), `vague-meeting.eml` ("sometime next week"), `exam-schedule.eml` (5 events), `injection-event.eml`
- [X] T076 [P] [US4] Contract tests for `SchedulerSchema` in `tests/contract/scheduler.test.ts` per `contracts/scheduler.contract.md`: valid and invalid outputs (`title` 1–120 chars, `status` enum, `start_local`/`end_local` regex `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$`, `duration_minutes` 1–20160, `timezone` ≤ 64, `location` ≤ 200, `meeting_url` ≤ 500, at most 5 events); the prompt keeps the email inside `<email>` with `<sent_at>` and `<user_timezone>` outside it
- [X] T077 [P] [US4] Unit tests in `tests/unit/scheduler-normalize.test.ts` for every rule in the "Normalization" table of `contracts/scheduler.contract.md`: `time_known: false` → `timeSet: false`, no links; invalid/absent zone → config `timezone`; missing end → duration or 60 min, all-day → next day; `end <= start` handled; non-`https:` meeting URL dropped; cancelled → no links; `end <= now` → no links; > 3 events → first 3 + `eventsOmitted`; a DST-boundary case
- [X] T078 [P] [US4] Unit tests in `tests/unit/invite.test.ts` for the ical.js mapping: Google invite, Outlook Windows-zone invite resolves to the right instant, cancel → `cancelled`, `SEQUENCE > 0` → `rescheduled`, all-day `VALUE=DATE`, the meeting URL taken from the listed properties
- [X] T079 [P] [US4] Contract tests in `tests/contract/calendar-links.test.ts`: snapshots of the Google URL (`dates` in UTC `YYYYMMDDTHHMMSSZ`, all-day `YYYYMMDD/YYYYMMDD` exclusive end), the Outlook URL for both hosts (`startdt`, `enddt`, `allday`), and the `.ics` text (`METHOD:PUBLISH`, stable `UID`, escaping of `\ ; , \n`, 75-octet folding); `&`, `#`, newlines and `<script>` in titles are encoded; details capped at 500 chars
- [X] T080 [P] [US4] Integration test in `tests/integration/events.test.ts`: an invite email → event with no `scheduler` LLM call (FR-114); a plain meeting email → Event section + links + `event.ics` on the email channel only; Scheduler throws or returns invalid output → the report is delivered without events, shows the "Event detection failed" notice, and `scheduler failed` is logged (FR-119, constitution III); `ai.scheduler.enabled: false` → no scheduler AI calls, but invitations are still parsed; spam/promotion never reach the Scheduler

### Implementation for User Story 4

- [X] T081 [US4] Config in `src/config/schema.ts` / `src/config/load.ts`: root `timezone` (validated with `Intl.supportedValuesOf("timeZone")` or `"UTC"`, default process zone); `ai.scheduler` (`enabled`, plus `provider`/`model`/`api_key_env` required only when enabled; a missing block = disabled); `calendar.outlook_host` (`"outlook.live.com"` default | `"outlook.office.com"`)
- [X] T082 [US4] Types in `src/domain/types.ts`: `SchedulerSchema` (from `contracts/scheduler.contract.md`), `DetectedEvent` with the data-model.md fields (`title` ≤ 120, `status: "new" | "rescheduled" | "cancelled"`, `source: "invitation" | "ai"`, `timeSet`, `start`/`end` ISO UTC or `YYYY-MM-DD` when `allDay`, `allDay`, `timezone` IANA, `location` ≤ 200 or null, `meetingUrl` `https:` ≤ 500 or null, `links: { google, outlook } | null`); `Report.events`, `Report.eventsOmitted`, `Report.schedulerFailed`; `IncomingEmail.calendarParts` (max 3, 64 KB each), extracted in `src/fetcher/clean.ts`
- [X] T083 [P] [US4] Invitation parser in `src/calendar/invite.ts` (ical.js, mapping from `contracts/scheduler.contract.md`)
- [X] T084 [P] [US4] Link builders `googleCalendarUrl` and `outlookCalendarUrl` in `src/calendar/links.ts` (`URLSearchParams`, details = meeting URL + "From: <sender> — <subject>" capped at 500 chars)
- [X] T085 [P] [US4] `.ics` writer `icsFile(events, key, now)` in `src/calendar/ics.ts` (`METHOD:PUBLISH`, UTC or `VALUE=DATE`, RFC 5545 escaping and folding, `UID` = hash of the message key + event index)
- [X] T086 [P] [US4] Prompt `src/agents/prompts/scheduler.v1.md`: what counts as an event, local times only, resolve relative dates from `<sent_at>`, `timezone` null unless stated, `time_known: false` without a usable date+time, at most 5 events, and the untrusted-data rules from `analyst.v1.md`
- [X] T087 [US4] Scheduler agent in `src/agents/scheduler.ts`: invite first, else one LLM call (temperature 0, retry per 001), then normalization with Luxon (rules from T077) and link building; returns `{ events, eventsOmitted, usage | null }`
- [X] T088 [US4] `src/agents/llm.ts`: build the `scheduler` model when enabled; `TEMPERATURE.scheduler = 0`
- [X] T089 [US4] Pipeline step in `src/orchestrator/pipeline.ts`: after the Analyst, for IMPORTANT emails only, run the Scheduler; on error set `schedulerFailed: true`, log `scheduler failed`, continue; add usage to the email's totals
- [X] T090 [US4] `src/courier/report.ts`: put `events`/`eventsOmitted` on the report
- [X] T091 [US4] Email channel: render the Event section (`📅` lines, times in the config zone with the original zone in brackets when different, "time not set", "Cancelled"/"Rescheduled", both links, "+N more events") in `src/courier/channels/email/render.ts`; attach `event.ics` (`text/calendar; method=PUBLISH; charset=utf-8`) in `src/courier/channels/email/email-channel.ts` when any event has links
- [X] T092 [US4] Telegram: the same Event section in `src/courier/channels/telegram/render.ts`, with the shortening order from `contracts/report.contract.md` (excerpt first, then event location lines, then split)
- [X] T093 [US4] Eval script `scripts/eval-scheduler.ts` over labeled `.eml` files (`<dir>/with-events/*.eml` + `*.expected.json`, `<dir>/no-events/*.eml`): prints event accuracy (start, end, title) and the false-positive count (targets: ≥ 90% correct, 0 false positives, SC-106); unit-test the scoring in `tests/unit/eval-scheduler-score.test.ts`
- [X] T094 [US4] README: `ai.scheduler`, `timezone` (Docker containers default to UTC) and `calendar.outlook_host` in the Step 2 tables; the Event section in "Reports" (the assistant never writes to your calendar; you add events with the links or `.ics`); Privacy note that calendar links send event details to Google/Microsoft only when you click; `eval:scheduler` in Commands in `README.md`

**Checkpoint**: Events are suggested with working links; 0 calendar changes (SC-106, SC-107).

---

## Phase 9: User Story 5 - AI cost in the logs (Priority: P3)

**Goal**: Every AI call logs tokens, latency and estimated cost; each email logs its total.

**Independent Test**: One important email with all three agents → three `ai call` lines and an
`email reported` line whose `costUsd` equals their sum (quickstart §6).

### Tests for User Story 5

- [X] T095 [P] [US5] Unit tests in `tests/unit/prices.test.ts`: a config override beats the built-in price; exact `"<provider>/<model>"` match; longest-prefix match for dated IDs; unknown → `null`; cost = `(in × input_per_mtok + out × output_per_mtok) / 1e6` rounded to 6 decimals
- [X] T096 [P] [US5] Integration test in `tests/integration/ai-usage.test.ts` with a fake LLM returning fixed usage: three `ai call` lines with `role`, `provider`, `model`, `tokensIn`, `tokensOut`, `ms`, `costUsd`; the `email reported` line has `aiCalls: 3` and `costUsd` equal to the sum; an unknown model → total `null` and exactly one `no price for model` warning across two emails; rules-only emails log `aiCalls: 0, costUsd: 0`; `processed_messages.cost_usd` matches

### Implementation for User Story 5

- [X] T097 [P] [US5] `src/agents/prices.ts`: `PRICES_AS_OF`, `BUILT_IN_PRICES` keyed `"<provider>/<model>"` (fill from the official OpenAI, Anthropic and Google pricing pages for the models in `config.example.json` and their current small/medium models; record the date), and `estimateCost()` per `contracts/ai-usage.contract.md`
- [X] T098 [US5] `ai.prices` (map of model → `{ input_per_mtok: number ≥ 0, output_per_mtok: number ≥ 0 }`) in `src/config/schema.ts` and `src/config/load.ts`
- [X] T099 [US5] `src/agents/llm.ts`: measure latency, compute `costUsd`, return the extended `LlmUsage`, log `ai call` per call (calls that failed without usage log zeros and `error`), and warn once per model per process with the `ai.prices` hint
- [X] T100 [US5] `src/orchestrator/pipeline.ts`: aggregate `costUsd` (null if any call is null) and `aiCalls`; add them to the `email reported` / `email skipped` lines (`costUsd: 0` on rules-only paths); store `costUsd` in `ProcessedRecord` → `processed_messages.cost_usd` via `src/store/sqlite-store.ts`
- [X] T101 [US5] Startup log line in `src/index.ts` includes `pricesAsOf` and `"costs are estimates"`
- [X] T102 [US5] README "AI cost" section (reading `ai call` lines, estimates dated `pricesAsOf`, setting `ai.prices`) and a troubleshooting row for `no price for model, cost unknown` in `README.md`

**Checkpoint**: Cost is visible in `docker compose logs` (SC-108).

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T103 README leftovers per plan.md "Documentation Plan": Step 5 Run and host (set `TZ`/`timezone`, `data/` holds the database **and grants**, back it up and keep it private), Validate step text, Commands (`auth <id>`, `auth --email-channel`, `auth --status`, `eval:scheduler`), Development (links to `specs/001-…` and `specs/002-…`), config reference links to `specs/002-oauth-providers-calendar/contracts/config.schema.md` in `README.md`
- [X] T104 Docs acceptance checks: extend `tests/contract/config-example.test.ts` so every key path in `config.example.json` appears in `README.md`; manually confirm `grep -in "app password" README.md` only matches "Other providers" and "Upgrading from 001", and that the Telegram-only path never asks for SMTP, a password or a send grant
- [X] T105 [P] Security pass: a test in `tests/unit/logger.test.ts` that drives a refresh through `src/auth/tokens.ts` and asserts no access/refresh token or client secret appears in log output; confirm `data/grants` is covered by `.gitignore` and `.dockerignore`
- [X] T106 Run `npm run typecheck && npm run lint && npm test` and the GreenMail e2e (`docker compose --profile test up -d greenmail && npm run test:e2e`); fix failures
- [ ] T107 Live run of `specs/002-oauth-providers-calendar/quickstart.md` §1–§9 with real Gmail, Outlook and Yahoo accounts; record the SC-103 timing, the SC-102 consent-screen check and the `eval:scheduler` results in the PR description

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; **blocks all stories**. Inside: T005 → T006 → T007 → (T008 → T009) and (T010, T011) → T012 → rest; T013–T015, T021, T022 are [P] once T012 is green.
- **US1 (Phase 3)**: after Foundational. MVP.
- **US2 (Phase 4)**: after Foundational. Independent of US1 in code; T050 extends README sections written in T037, so run docs after US1 docs (or merge carefully).
- **US6 (Phase 5)**: after Foundational. T053/T054 touch the `delivery.email.oauth` exclusivity added in T034, so run after US1.
- **US7 (Phase 6)**: after Foundational. The Microsoft link (`RawMessage.webLink`) needs US2's `GraphMailSource`; the Gmail link works without it.
- **US3 (Phase 7)**: after Foundational. Shares renderer files with US7 and US4; run sequentially to avoid conflicts.
- **US4 (Phase 8)**: after Foundational. Its renderer tasks follow US7/US3 renderer changes; `event.ics` uses the MIME channel from T025.
- **US5 (Phase 9)**: after Foundational. Best after US4 so the Scheduler's calls are included.
- **Polish (Phase 10)**: after all desired stories.

### Story completion order

```text
Setup → Foundational ─┬─▶ US1 (MVP) ─▶ US6
                      ├─▶ US2 ───────▶ US7 (Graph link)
                      └─▶ US3 ─▶ US4 ─▶ US5 ─▶ Polish
```

### Within each story

- Fixtures and tests first, failing → types/config → adapters/agents → pipeline wiring → renderers → docs.

---

## Parallel Examples

### Foundational (after T012)

```text
T013 tests/integration/migration-3.test.ts
T014 src/lib/logger.ts
T015 src/config/providers.ts
T021 tests/contract/config-002.test.ts
T022 src/lib/api-client.ts
```

### User Story 1

```text
T026 tests/fixtures/http/gmail/
T027 tests/integration/gmail-source.test.ts
T028 tests/unit/google-oauth.test.ts
T029 tests/contract/mail-sender.test.ts
T030 tests/integration/oauth-revoked.test.ts
# later
T038 config.example.json / .env.example / docker-compose.yml
T039 tests/contract/config-example.test.ts
```

### User Story 2

```text
T040 tests/fixtures/http/graph/   T041 graph-source test   T042 microsoft-oauth test
T043 mail-sender (Graph cases)    T044 multi-provider test
```

### User Story 4

```text
T075 fixtures  T076 scheduler schema  T077 normalize  T078 invite  T079 links/ics  T080 events
# then
T083 src/calendar/invite.ts  T084 src/calendar/links.ts  T085 src/calendar/ics.ts  T086 scheduler.v1.md
```

---

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1 Setup, Phase 2 Foundational (001 suite green on the new ports, migration tested).
2. Phase 3 US1: Gmail read-only OAuth with docs.
3. **Stop and validate** with quickstart §1. This alone removes the app-password risk for Gmail users.

### Incremental delivery

1. + US2 → Outlook and presets (quickstart §2).
2. + US6 → free channel choice (§3).
3. + US7 → recipients and "Open original" (§7).
4. + US3 → brief reports (§4).
5. + US4 → meeting suggestions (§5).
6. + US5 → cost logs (§6).
7. Polish → docs checks and a live quickstart run (§8, §9).

Each step keeps all earlier tests green and is shippable on its own.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- Prompts are versioned source files (constitution): new prompts are new files, never edits to `analyst.v1.md`.
- Never log tokens, client secrets, or full bodies; every new log field is reviewed against constitution VII.
- Commit after each task or logical group, using Conventional Commits.
