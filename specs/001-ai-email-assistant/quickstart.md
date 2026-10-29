# Quickstart: Mail-Me AI Email Assistant

Target: from clone to first summary in under 15 minutes (SC-004).

## 1. Prerequisites
- Node.js ≥ 22 (or Docker)
- For each monitored mailbox: IMAP enabled and an **app password** (Gmail: Google Account → Security → 2-Step Verification → App passwords)
- At least one delivery channel:
  - **Email**: an SMTP account for sending reports, and a report address that is **not** one of the monitored mailboxes
  - **Telegram**: a Telegram account (you will create a bot below)
- An API key for OpenAI, Anthropic or Google Gemini

## 2. Configure
```bash
git clone <repo> mail-me && cd mail-me
cp config.example.json config.json
cp .env.example .env
```
- Edit `config.json`: accounts, `delivery` (email and/or telegram), `ai` models, `target_language`, `rules`.
- Put secrets in `.env`, using the names that `config.json` refers to:
```bash
SCHOOL_IMAP_PASSWORD=xxxx xxxx xxxx xxxx
SMTP_PASSWORD=xxxx xxxx xxxx xxxx
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=123456:ABC...   # only if Telegram is enabled
```

### Telegram setup (optional)
1. In Telegram, message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Open your new bot and send it `/start`.
3. Run `npm run telegram-chat-id`. It prints your chat ID. Put it in `delivery.telegram.chat_id` and set `enabled: true`.

> Privacy: Telegram bot chats are stored on Telegram's servers and are **not end-to-end encrypted**. Email summaries sent there are visible to Telegram.

### Email report address rule
`delivery.email.to` must **not** be one of the mailboxes you monitor, or the assistant would read its own reports. Startup refuses a config where it is (Gmail dots and `+tags` are treated as the same address). Use your primary inbox, and monitor only your other accounts.

## 3. Validate
```bash
npm ci
npm run check-config      # exits 0, or prints e.g. "Invalid config: delivery — enable at least one channel"
npm run check-delivery    # sends a test report to every enabled channel
```

## 4. Run
```bash
npm run start             # polling daemon
# or a single pass (for cron/systemd timer):
npm run run-once
# or Docker:
docker compose up -d
```

## 5. Verify
1. Send a test email to a monitored mailbox, for example "Assignment 3 due Friday 5pm, submit via portal".
2. Within one poll interval, `[AI Summary] …` arrives on each enabled channel (report email and/or Telegram), in your target language, with the action item and deadline.
3. Send an email whose subject contains a drop keyword (e.g. "50% discount"). It is **not** forwarded, and the log shows `decision=DROP_KEYWORD outcome=SKIPPED`.
4. Restart the service. No duplicate summaries arrive.
5. With both channels enabled, block network access to api.telegram.org briefly. The email arrives once, and Telegram catches up on a later poll without a second email.

## Notes
- Mailboxes are opened **read-only**: nothing in your source inboxes is marked read, moved or deleted.
- On the first start only new mail is processed. Set `lookback_hours` to backfill.
- Email content is sent to the AI provider you configured and to the delivery channels you enabled. Nothing else leaves your host.
