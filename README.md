# mail-me

A self-hosted AI email assistant. It watches one or more mailboxes and filters out spam and
promotions. For each important email, it sends you a short summary in your language (key points,
action items with deadlines, urgency) by email, Telegram, or both.

- **Read-only.** Your monitored mailboxes are never marked read, moved, flagged or deleted.
- **Never loses mail.** If the AI fails, times out or is unsure, the email is forwarded anyway, with a "not summarized" notice.
- **Exactly once.** Each email is reported once per channel, including across restarts and outages.
- **Cheap.** Whitelist and keyword rules run before any AI call. You can use a small model to classify and a stronger one to summarize.
- **Private.** It runs as one process with a local SQLite file and no telemetry. Email content only goes to the AI provider and the delivery channels you configure.

## How it works

```text
            ┌──────────── every poll, per account ────────────┐
 IMAP  ──▶  │ fetch (read-only) → clean to text → rules engine │
 (N boxes)  └─────────────────────────┬───────────────────────┘
                                      │
          ┌───────────────┬───────────┼──────────────┬──────────────────┐
     already seen     self-sent    whitelist     drop keyword        no rule hit
      (ignore)     (our report)   → IMPORTANT    → PROMOTION    → Gatekeeper (LLM)
                     skip            │            skip          SPAM / PROMOTION → skip
                                     │                          IMPORTANT, unsure or failed ┐
                                     ▼                                                      │
                          Analyst (LLM): summary, key points,  ◀────────────────────────────┘
                          action items, urgency, translation
                          (failed → fallback "not summarized")
                                     │
                                     ▼
                          Courier: one stored Report → Email (SMTP) and/or Telegram (Bot API)
                          each channel retried on its own until delivered
```

| Module             | Role                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| `src/fetcher`      | IMAP (`imapflow`, EXAMINE + BODY.PEEK), MIME parsing, HTML → text, truncation      |
| `src/rules`        | Deterministic rules: already processed → self-sent → whitelist → drop keyword      |
| `src/agents`       | Gatekeeper (classify) and Analyst (summarize/translate), schema-validated with zod |
| `src/courier`      | Report building, email and Telegram renderers, per-channel dispatcher              |
| `src/store`        | SQLite: mailbox positions, processed records, pending reports, delivery status     |
| `src/orchestrator` | Per-email pipeline, one polling loop per account with backoff                      |

---

# Setup guide

Plan for about 15 minutes. You will:

1. Get your credentials.
2. Create `config.json` and `.env`.
3. (Optional) Find your Telegram chat ID.
4. Validate the setup.
5. Run and host the service.
6. Check that it works.

## Prerequisites

Pick one way to run it:

- **Docker** with the Docker Compose plugin. Recommended for servers, NAS boxes and Raspberry Pi:
  [Install Docker](https://docs.docker.com/get-docker/) · [Install Compose](https://docs.docker.com/compose/install/linux/).
  Check with `docker compose version`. If it says `unknown command: docker compose`, or
  `docker compose run --rm …` fails with `unknown flag: --rm`, the plugin is missing. Install it:
  - Ubuntu's `docker.io` package: `sudo apt-get install docker-compose-v2`
  - Docker's own apt repo (`docker-ce`): `sudo apt-get install docker-compose-plugin`
  - Docker Desktop: already included

  Or skip Compose and use the [`docker run` equivalents](#without-docker-compose).

- **Node.js 22 or newer**: [nodejs.org](https://nodejs.org/)

Then get the code:

```bash
git clone <this repo> mail-me && cd mail-me
```

## Step 1: Get your credentials

You need three kinds of credentials. Create them on the official pages linked below.

### a) A mailbox password for IMAP (and SMTP)

mail-me logs in to each **monitored** mailbox over IMAP. If you use the email delivery channel, it
also needs one SMTP account to **send** reports from. Most providers don't accept your normal password for this, so you need an **app password**.

- **Gmail / Google Workspace**:
  - [Sign in with app passwords](https://support.google.com/accounts/answer/185833). This requires 2-Step Verification. You can create the password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
  - Server settings: [IMAP/SMTP settings for Gmail](https://support.google.com/mail/answer/7126229) (IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:465`).
- **Other providers**: look up "IMAP SMTP settings" and "app password" in your provider's help center.

### b) An AI API key

One key is enough. You can use different providers for the two AI roles if you like.

| Provider      | Create a key                                                                       | Pick a model ID                                                  |
| ------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OpenAI        | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)               | [Models](https://platform.openai.com/docs/models)                |
| Anthropic     | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | [Models](https://docs.anthropic.com/en/docs/about-claude/models) |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey)                   | [Models](https://ai.google.dev/gemini-api/docs/models)           |

For the **gatekeeper** (spam/promotion classifier), a small, cheap model is enough. For the **analyst** (summaries and translation), use a stronger one.

### c) (Optional) A Telegram bot token

If you want reports on Telegram, create a bot with @BotFather by following
[Obtain your bot token](https://core.telegram.org/bots/tutorial#obtain-your-bot-token) in the official tutorial. Keep the token for step 2.

## Step 2: Create `config.json` and `.env`

You need **both** files. They are git-ignored, so your personal data and secrets are never committed.

| File          | What it holds                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `config.json` | Settings: accounts, servers, delivery channels, AI models, rules. **No secrets.**                |
| `.env`        | Secrets only: passwords, API keys, bot token. `config.json` refers to them **by variable name**. |

Start from the examples:

```bash
cp config.example.json config.json
cp .env.example .env
```

### Edit `config.json`

**`accounts`**: one entry per mailbox account to monitor.

| Field                           | Example                           | Meaning                                                                |
| ------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `id`                            | `"school"`                        | Short unique name (letters, digits, `-`, `_`)                          |
| `label`                         | `"School"`                        | Shown on each report so you know where it came from                    |
| `email`                         | `"student@university.edu"`        | The account's address                                                  |
| `imap.host` / `port` / `secure` | `"imap.gmail.com"`, `993`, `true` | From your provider's IMAP settings                                     |
| `imap.user`                     | `"student@university.edu"`        | IMAP login, usually the address                                        |
| `imap.password_env`             | `"SCHOOL_IMAP_PASSWORD"`          | **Name** of the `.env` variable holding the app password               |
| `mailboxes`                     | `["INBOX"]`                       | Folders to watch (optional, default `INBOX`)                           |
| `lookback_hours`                | `0`                               | On the first start, also process mail from the last N hours (optional) |

**`delivery`**: enable at least one channel.

| Field                    | Meaning                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email.enabled`          | `true` to receive reports by email                                                                                                                                                                                                             |
| `email.to`               | Where reports go. **Must not be one of the monitored mailboxes**, or mail-me would read its own reports. Startup refuses it (case, `+tags` and Gmail dots are ignored when comparing). Use your primary inbox and monitor your other accounts. |
| `email.smtp.*`           | The account that **sends** the reports: `host`, `port`, `secure`, `user`, `password_env` (a `.env` variable name), and an optional `from`                                                                                                      |
| `telegram.enabled`       | `true` to receive reports on Telegram (see step 3)                                                                                                                                                                                             |
| `telegram.bot_token_env` | **Name** of the `.env` variable holding the bot token                                                                                                                                                                                          |
| `telegram.chat_id`       | Your chat ID as a string (see step 3)                                                                                                                                                                                                          |

**`ai`**:

| Field                    | Meaning                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `gatekeeper` / `analyst` | Each has a `provider` (`openai`, `anthropic` or `google`), a `model` ID, and `api_key_env` (a `.env` variable name) |
| `target_language`        | Language for the summaries, e.g. `"Vietnamese"`, `"English"`                                                        |

For example, to use Gemini for classification:

```json
"gatekeeper": { "provider": "google", "model": "<gemini model id>", "api_key_env": "GOOGLE_GENERATIVE_AI_API_KEY" }
```

If Anthropic replies "This API key is not scoped to a workspace", either create a workspace-scoped key in the Anthropic Console, or add `"workspace_id_env": "ANTHROPIC_WORKSPACE_ID"` to the `anthropic` role(s) and put the workspace ID in `.env`.

**`rules`** (optional):

| Field                  | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `whitelist_domains`    | Senders from these domains (and their subdomains) are always important, with no AI call                   |
| `drop_keywords`        | Whole words matched in the **subject or sender only**. A match is skipped as a promotion, with no AI call |
| `confidence_threshold` | Spam/promotion verdicts below this confidence (default 0.7) are forwarded anyway                          |

Everything else is optional and has sensible defaults:

- `schedule.poll_interval_seconds` (300)
- `delivery.max_attempts` (10)
- `limits.*`
- `storage.retention_days` (90)
- `logging.level`

The full reference is [config.schema.md](specs/001-ai-email-assistant/contracts/config.schema.md).

### Edit `.env`

Put one line per secret, using exactly the variable names from your `config.json`:

```bash
# accounts[0].imap.password_env
SCHOOL_IMAP_PASSWORD=abcd efgh ijkl mnop
# delivery.email.smtp.password_env
SMTP_PASSWORD=wxyz wxyz wxyz wxyz
# ai.*.api_key_env
OPENAI_API_KEY=sk-...
# delivery.telegram.bot_token_env (only if Telegram is enabled)
TELEGRAM_BOT_TOKEN=123456789:AA...
```

Write values **without quotes** and keep comments on their own lines. Some Docker tools
(`docker run --env-file`) take everything after `=` literally, so `"…"` or a trailing `# …`
would become part of the secret.

**Adding a second account:** add another object to `accounts` with its own `id` and a new
`password_env` name (e.g. `"WORK_IMAP_PASSWORD"`). Then add `WORK_IMAP_PASSWORD=...` to `.env`.

## Step 3 (optional): Find your Telegram chat ID

1. Open your new bot in Telegram and send it `/start`.
2. With `TELEGRAM_BOT_TOKEN` set in `.env`, run:

   ```bash
   npm ci && npm run telegram-chat-id             # Node
   docker compose run --rm mail-me telegram-chat-id   # Docker
   ```

   No Compose plugin? See [Without Docker Compose](#without-docker-compose).

3. Copy the printed ID into `delivery.telegram.chat_id` (as a string, e.g. `"123456789"`), and set `delivery.telegram.enabled` to `true`.

## Step 4: Validate

```bash
# Node
npm ci
npm run check-config      # "Config OK", or an error naming the bad field
npm run check-delivery    # sends a test report to every enabled channel

# Docker
docker compose build
docker compose run --rm mail-me check-config
docker compose run --rm mail-me check-delivery
```

Fix anything reported, and re-run until both commands succeed.

## Step 5: Run and host

### Option A: Docker Compose (recommended)

```bash
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
docker compose up -d --build
docker compose logs -f mail-me
```

- It restarts automatically (`restart: unless-stopped`), including after a reboot once Docker starts.
- The database lives in `./data`. Keep `storage.path` at its default `data/mail-me.db`.
- To update: `git pull && docker compose up -d --build`.

#### Without Docker Compose

Plain `docker` works too. Every `docker compose run --rm mail-me <command>` in this guide becomes
`docker run --rm … mail-me <command>` with the same env file and mounts:

```bash
docker build -t mail-me .
mkdir -p data && sudo chown 1000:1000 data

# one-off commands: telegram-chat-id, check-config, check-delivery, run-once
docker run --rm --env-file .env \
  -v "$PWD/config.json:/app/config.json:ro" -v "$PWD/data:/app/data" \
  mail-me telegram-chat-id

# the long-running service
docker run -d --name mail-me --restart unless-stopped --env-file .env \
  -v "$PWD/config.json:/app/config.json:ro" -v "$PWD/data:/app/data" \
  mail-me
docker logs -f mail-me
```

To update: `git pull && docker build -t mail-me . && docker rm -f mail-me`, then run the
long-running command again.

### Option B: Node.js as a systemd service

```bash
npm ci && npm run build
npm prune --omit=dev
```

Create `/etc/systemd/system/mail-me.service`, replacing the user and the path:

```ini
[Unit]
Description=mail-me AI email assistant
After=network-online.target
Wants=network-online.target

[Service]
User=youruser
WorkingDirectory=/home/youruser/mail-me
ExecStart=/usr/bin/node dist/index.js start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mail-me
journalctl -u mail-me -f
```

`config.json` and `.env` are read from `WorkingDirectory`. To use another config path, add
`Environment=MAIL_ME_CONFIG=/path/to/config.json`.

### Option C: Single passes from cron

If you prefer a scheduler you already run, `run-once` polls every account once and exits:

```cron
*/5 * * * * cd /home/youruser/mail-me && /usr/bin/node dist/index.js run-once >> mail-me.log 2>&1
```

On the first start, only mail that arrives **after** startup is processed (unless you set `lookback_hours`).

## Step 6: Check that it works

1. Send a test email to a monitored mailbox, for example "Assignment 3 due Friday 5pm, submit via portal".
2. Within one poll interval (5 minutes by default), an `[AI Summary] …` report arrives on each
   enabled channel. It should be in your target language and include the action item and deadline.
3. Send an email whose subject contains one of your drop keywords (e.g. "50% discount"). It is
   **not** reported, and the log shows `"decision":"DROP_KEYWORD","outcome":"SKIPPED"`.
4. Restart the service. No duplicate reports arrive.
5. With both channels enabled, briefly block access to `api.telegram.org`. The email report
   arrives once, and Telegram catches up on a later poll without a second email.

## Troubleshooting

| Symptom                                                                 | Fix                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Invalid config: <field> — …`                                           | The message names the exact field. Fix it in `config.json`, or set the missing variable in `.env`                                          |
| `unknown command: docker compose` or `unknown flag: --rm`               | The Compose plugin is not installed. Install it (see [Prerequisites](#prerequisites)) or use [plain `docker run`](#without-docker-compose) |
| `not a Telegram bot token` or `telegram getUpdates: 404 Not Found`      | The token in `.env` is wrong or has quotes around it. Write it as `TELEGRAM_BOT_TOKEN=123456789:AA...`, with no quotes                     |
| IMAP `auth failed` / `AUTHENTICATIONFAILED`                             | Use an app password, not your normal password. Check that IMAP is allowed for the account                                                  |
| Telegram `chat not found`                                               | Send `/start` to your bot first, then check `chat_id`                                                                                      |
| Telegram `Unauthorized`                                                 | The bot token is wrong or was revoked. Get a new one from @BotFather                                                                       |
| Nothing arrives                                                         | Check the logs (`docker compose logs mail-me` or `journalctl -u mail-me`). Each email logs one JSON line with its `decision` and `outcome` |
| Permission error on `/app/data` in Docker (`EACCES`, `SQLITE_CANTOPEN`) | `./data` is not writable by uid 1000. Run `sudo chown 1000:1000 data`                                                                      |

---

## Privacy

- Mailboxes are opened read-only (IMAP `EXAMINE`, bodies fetched with `BODY.PEEK`).
- The cleaned email text (truncated to `limits.max_body_chars`) is sent to the AI provider you configured, and nowhere else.
- Reports go only to the channels you enabled. **Telegram bot chats are stored on Telegram's
  servers and are not end-to-end encrypted.** Anything in a Telegram report is visible to Telegram.
- The local database holds message identifiers, sender, subject, the decision, token counts and,
  while delivery is pending, the report itself (summary plus a short excerpt). It never holds full
  bodies. Records are deleted after `storage.retention_days` (default 90).
- Logs are structured JSON. They contain each decision and its token usage, but no email bodies,
  and secrets are redacted.
- Email content is treated as untrusted. It goes to the AI only inside a delimited data block,
  every AI response is schema-validated, and every rendered value is escaped.

## Commands

| Command                            | What it does                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run start`                    | Poll all accounts on the configured interval (dev, via tsx)                                                 |
| `npm run start:prod`               | Same, from the built `dist/` (after `npm run build`)                                                        |
| `npm run run-once`                 | One pass over all accounts, then exit                                                                       |
| `npm run check-config`             | Validate the config and secrets                                                                             |
| `npm run check-delivery`           | Send a test report to every enabled channel                                                                 |
| `npm run telegram-chat-id`         | List chats that have messaged your bot                                                                      |
| `npm run eval:gatekeeper -- <dir>` | Measure filtering on labelled `.eml` files in `<dir>/{important,promotion,spam}/`. This makes real AI calls |

In Docker, use the same command names: `docker compose run --rm mail-me <command>`. Use `--config <path>` or
`MAIL_ME_CONFIG` to point to another config file.

## Development

```bash
npm test              # unit, contract and integration tests (fakes, no network)
npm run typecheck && npm run lint
docker compose --profile test up -d greenmail && npm run test:e2e   # real IMAP + SMTP
```

The design documents (spec, plan, contracts, data model) are in `specs/001-ai-email-assistant/`.

## License

MIT
