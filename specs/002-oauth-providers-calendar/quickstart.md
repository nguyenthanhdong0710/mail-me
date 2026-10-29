# Quickstart: Validating Feature 002

How to prove each user story works end to end. Config shapes are in
[contracts/config.schema.md](./contracts/config.schema.md); command output is in
[contracts/auth-cli.contract.md](./contracts/auth-cli.contract.md).

## Prerequisites

- Node ≥ 22 or Docker Compose, the repo built (`npm ci`), an AI API key.
- For live OAuth checks: your own Google Cloud OAuth client (Desktop app, Gmail API enabled,
  consent screen **In production**) and/or a Microsoft Entra app registration (public client,
  "Allow public client flows" on, delegated `Mail.Read`, `Mail.Send`, `User.Read`).
- Test mailboxes: one Gmail, one Outlook.com, one password provider (e.g. Yahoo with an app password).

## 0. Automated checks (no network)

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all pass. New suites cover: config schema (presets, auth/provider mismatch, channel
combinations, grant checks), Gmail/Graph sources and OAuth refresh against faked `HttpFetch`,
migration 3 on a 001 database, Scheduler schema + normalization + invitations, calendar links/.ics,
brief clamping, recipients/webLink rendering, cost estimates and log lines.

## 1. Gmail with read-only OAuth (US1)

```bash
# config: { "id": "gmail", "email": "<you>@gmail.com", "provider": "gmail" } + auth.google
npm run check-config            # ✗ accounts[0] ("gmail"): not signed in. Run: mail-me auth gmail
npx tsx src/index.ts auth gmail # consent screen must list ONLY "Read your email" (SC-102)
ls -l data/grants               # gmail.read.json, -rw-------
grep -i password .env           # no Gmail password (SC-101)
npm start
```

Send yourself an important email from another address → report arrives as in 001.

- Renewal (US1-4): leave it running > 1 hour; mail keeps arriving, no errors.
- Revocation (US1-5): remove access at myaccount.google.com → Security → Third-party access.
  Next poll logs `sign-in revoked or expired, run mail-me auth gmail`; other accounts keep working.
  Send a test email, sign in again, and confirm that email is still reported.
- Docker headless: `docker compose run --rm -p 53682:53682 mail-me auth gmail`, open the URL on
  your laptop, paste the final address back.

## 2. Outlook + password provider together (US2)

```bash
# accounts: { "id": "outlook", "provider": "microsoft", ... } and
#           { "id": "yahoo", "provider": "yahoo", "imap": { "password_env": "YAHOO_IMAP_PASSWORD" } }
npx tsx src/index.ts auth outlook   # device code; consent lists "Read your mail" only
npm start                           # logs one notice: account "yahoo" uses a password, OAuth is safer
```

Send an important email to each → two reports labeled with their account. A work tenant that
needs admin approval prints the admin message (US2-2). Setting `"provider": "microsoft", "auth": "password"`
fails `check-config` with an explanation (FR-108).

## 3. Delivery channel combinations (US6)

Run `npm run check-config` and `npm run check-delivery` with:

| email.enabled | telegram.enabled | Expected |
|---|---|---|
| true (oauth sender) | false | test report by email only; no Telegram settings needed |
| false (no smtp/oauth block at all) | true | starts clean, Telegram only, no sending credential anywhere (SC-110) |
| true | true | one report on each channel |
| false | false | exit 2: `delivery — enable at least one channel …` |

Send-only grant: `npx tsx src/index.ts auth --email-channel`; consent lists only "Send email on
your behalf".

## 4. Brief reports (US3)

```bash
npx vitest run tests/integration/brief-style.test.ts   # 20 fixed emails, fake LLM returning over-long output
```

Expected: every brief report ≤ 2-sentence TL;DR, ≤ 3 points, excerpt ≤ 300 chars, "Action needed: No"
when empty; ≥ 90% of Telegram renders are a single message. Live check: set `ai.analyst.style` to
`"detailed"` and confirm the 001 layout returns.

## 5. Meeting suggestions (US4)

Send an important email: *"Project sync on Thursday 6 Nov at 14:00 for 45 minutes, Teams link: https://teams.microsoft.com/l/meetup-join/…"*.

- Report shows `📅 Project sync — Thu 6 Nov, 14:00–14:45 (<your zone>)` and both links.
- Open each link: a prefilled event with that start, 45-minute end, and the Teams URL (SC-106).
- Email report has `event.ics`; opening it in a calendar app shows the same event.
- Forward a real calendar invitation → event appears; log shows no `scheduler` AI call (US4-2).
- "let's meet sometime next week" → `time not set`, no links. A cancellation → `Cancelled`, no links.
- `ai.scheduler.enabled: false` → no `role: "scheduler"` log lines.
- Evaluation set: `npm run eval:scheduler` (30+ labeled emails) prints event accuracy and false
  positives (targets: ≥ 90% correct, 0 suggested for no-event emails).

## 6. AI cost in logs (US5)

```bash
docker compose logs -f mail-me | grep -E '"ai call"|"email reported"'
```

For one important email with all three agents: three `ai call` lines with `tokensIn`, `tokensOut`,
`costUsd`, and one `email reported` line whose `costUsd` equals their sum. Set a model with no
price → `costUsd: null` and a single `no price for model` warning. Add `ai.prices` for it → cost appears.

## 7. Recipients and "Open original" (US7)

- Email to the monitored Gmail with two To and one Cc → `👥 To: A, you · Cc: C`.
- Bcc to the monitored address → `received at <address>`.
- Seven To recipients → first 5 then `and 2 more`.
- Gmail and Outlook reports have "Open original", which opens the message when signed in to that
  account; Yahoo reports have none.

## 8. Docs (FR-110, FR-127)

- `grep -in "app password" README.md` matches only the "Other providers" and "Upgrading from 001" sections.
- `npx vitest run tests/contract/config-example.test.ts`: `config.example.json` parses against the
  schema, and every key in it is mentioned in the README.
- On a fresh machine, follow the README alone for Gmail with OAuth and time it: first report in
  under 30 minutes (SC-103).
- Follow the README's Telegram-only path: it never asks for SMTP settings, a password or a send grant (SC-110).

## 9. Upgrade from 001

Copy a 001 `data/mail-me.db` (with a pending report), start 002 with the old config unchanged:
migration 3 runs, the pending report is delivered, and no old mail is replayed or skipped.
