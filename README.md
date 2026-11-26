# mail-me

A self-hosted AI email assistant. It watches one or more mailboxes and filters out spam and
promotions. For each important email, it sends you a short summary in your language by email,
Telegram, or both: a TL;DR, key points, action items with deadlines, who the email was sent to,
any meeting it mentions with one-click "add to calendar" links, and a link to open the original.

- **Read-only, enforced by your provider.** Gmail and Outlook / Microsoft 365 sign in with OAuth and grant **read-only** mail access, so mail-me cannot send, change or delete anything in them, and no mailbox password is stored. Other mailboxes are opened read-only over IMAP.
- **Works with many providers.** Gmail, Outlook / Hotmail / Microsoft 365, Yahoo, iCloud, Fastmail, Zoho, GMX, AOL, or any IMAP server.
- **Short reports.** Readable at a glance on a phone; a detailed style is one setting away.
- **Meeting suggestions.** Finds meetings, classes, interviews and other plans, and offers "Add to Google Calendar" / "Add to Outlook calendar" links plus a calendar file. It never touches your calendar.
- **Never loses mail.** If the AI fails, times out or is unsure, the email is forwarded anyway, with a "not summarized" notice.
- **Exactly once.** Each email is reported once per channel, including across restarts and outages.
- **Cheap, and you can see the cost.** Whitelist and keyword rules run before any AI call, each AI role can use its own model, and the logs show the estimated cost of every AI call and every email.
- **Private.** It runs as one process with a local SQLite file and no telemetry. Email content only goes to the AI provider and the delivery channels you configure.

## How it works

```text
              ┌──────────────── every poll, per account ────────────────┐
 IMAP or      │ fetch (read-only) → clean to text → rules engine         │
 Gmail API or └────────────────────────────┬────────────────────────────┘
 Graph (N boxes)                           │
          ┌───────────────┬────────────────┼──────────────┬──────────────────┐
     already seen     self-sent        whitelist     drop keyword        no rule hit
      (ignore)     (our report)       → IMPORTANT    → PROMOTION    → Gatekeeper (LLM)
                     skip                 │            skip          SPAM / PROMOTION → skip
                                          │                          IMPORTANT, unsure or failed ┐
                                          ▼                                                      │
                     Analyst (LLM): TL;DR, key points, action items, translation  ◀──────────────┘
                     (failed → fallback "not summarized")
                                          │
                     calendar invitation? → read it (no AI)
                     otherwise Scheduler (LLM, optional) → events → calendar links + .ics (code)
                                          │
                                          ▼
                     Courier: one stored Report → Email (SMTP, Gmail or Graph send-only)
                     and/or Telegram (Bot API), each channel retried on its own until delivered
```

| Module             | Role                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/fetcher`      | Read-only sources: IMAP (`imapflow`), Gmail API, Microsoft Graph; MIME parsing, HTML → text, recipients |
| `src/auth`         | OAuth sign-in (`mail-me auth`), grant files, token renewal, least-privilege scopes                      |
| `src/rules`        | Deterministic rules: already processed → self-sent → whitelist → drop keyword                           |
| `src/agents`       | Gatekeeper (classify), Analyst (summarize/translate), Scheduler (find events), cost estimates           |
| `src/calendar`     | Calendar invitations, "add to calendar" links, `.ics` files, event display                              |
| `src/courier`      | Report building and length limits, email and Telegram renderers, senders, per-channel dispatcher        |
| `src/store`        | SQLite: mailbox positions, processed records, pending reports, delivery status                          |
| `src/orchestrator` | Per-email pipeline, one polling loop per account with backoff                                           |

---

# Setup guide

Plan for about 30 minutes if you use Gmail or Outlook (registering your own OAuth app takes most
of it), or about 15 minutes for other providers. You will:

1. Choose your providers and delivery channels.
2. Get your credentials.
3. Create `config.json` and `.env`.
4. Sign in your Gmail / Outlook accounts.
5. (Only if you use Telegram) Find your Telegram chat ID.
6. Validate the setup.
7. Run and host the service.
8. Check that it works.

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

## Step 1: Choose your setup

**Mailboxes to monitor.** Each account uses the safest sign-in its provider offers:

| Provider                                   | `provider`   | Sign-in                        | Follow                                                |
| ------------------------------------------ | ------------ | ------------------------------ | ----------------------------------------------------- |
| Gmail, Google Workspace                    | `gmail`      | OAuth, read-only (default)     | [2a](#a-gmail-register-your-own-google-oauth-app)     |
| Outlook.com, Hotmail, Live, Microsoft 365  | `microsoft`  | OAuth, read-only (only option) | [2b](#b-outlook--microsoft-365-register-an-entra-app) |
| Yahoo, iCloud, Fastmail, Zoho, GMX, AOL    | e.g. `yahoo` | App password                   | [2c](#c-other-providers-app-password)                 |
| A university, company or other IMAP server | (omit)       | Password                       | [2c](#c-other-providers-app-password)                 |

**Where reports go.** Email, Telegram, or both. **You need at least one**, and neither is required:

- **Email reports**: you also need an account that _sends_ them ([2e](#e-only-if-you-use-email-reports-a-sending-account)).
- **Telegram reports**: you need a bot ([2f](#f-only-if-you-use-telegram-a-bot-token)). A Telegram-only setup needs no sending account and no mail password at all.

## Step 2: Get your credentials

Create everything on the official pages linked below. You own every credential: mail-me has no
shared app or server.

### a) Gmail: register your own Google OAuth app

You do this once; it can serve all your Gmail accounts.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (any name).
2. [Enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) for it.
3. Open [Google Auth Platform → Branding / Audience](https://console.cloud.google.com/auth/overview) and configure the consent screen: user type **External**, an app name, and your address as the support and developer contact. Under **Audience**, add your Gmail address(es) as test users.
4. Under **Data access**, add the scope `https://www.googleapis.com/auth/gmail.readonly`. If you will send email reports from a Gmail account with a send-only sign-in (the recommended way, [step 2e](#e-only-if-you-use-email-reports-a-sending-account)), also add `https://www.googleapis.com/auth/gmail.send`. Skip it if you send over SMTP or only use Telegram.

   This list only says what the app **may** ask for; it grants nothing by itself. Each sign-in asks for exactly one of these scopes, so your monitored accounts get read-only access and never `gmail.send`. mail-me rejects a read sign-in that carries any other Gmail permission, and a send sign-in that can read.

5. Under **Clients**, create an OAuth client of type **Desktop app**. Copy the **client ID** into `config.json` (`auth.google.client_id`) and the **client secret** into `.env` (`GOOGLE_OAUTH_CLIENT_SECRET`).
6. **Avoid weekly sign-outs:** under **Audience**, click **Publish app** so the status is **In production**. Apps left in _Testing_ get sign-ins that expire after 7 days. A personal app with fewer than 100 users needs no Google review; the consent screen just shows a "Google hasn't verified this app" warning. Since it is your own app, click **Advanced → Go to (your app)** to continue.

Official docs: [Using OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app) · [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

### b) Outlook / Microsoft 365: register an Entra app

1. Open [Microsoft Entra admin center → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) (any Microsoft account works; personal accounts get a free directory) and choose **New registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**. No redirect URI is needed.
3. Under **Authentication**, set **Allow public client flows** to **Yes**.
4. Under **API permissions → Microsoft Graph → Delegated**, add `Mail.Read` and `User.Read`. Only if you will **send** email reports from a Microsoft account, also add `Mail.Send`.
5. Copy the **Application (client) ID** into `config.json` (`auth.microsoft.client_id`). There is no secret.

Official docs: [Register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) · [Device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).

#### Microsoft 365 admin approval

Many school and work organizations block apps that users approve themselves. If sign-in says an
administrator must approve the app, send your IT administrator the app (client) ID and ask them to
grant admin consent for `Mail.Read` and `User.Read`
([how admins grant consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)).
Getting that approval is up to you and your organization.

### c) Other providers: app password

These providers either have no OAuth for mail or limit it to approved partners, so mail-me signs in
with an **app password**. This is less safe than OAuth (an app password can usually do everything
your account can), and mail-me logs a reminder at startup. Use a dedicated app password you can
revoke at any time.

| `provider` | Create an app password                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- |
| `yahoo`    | [Yahoo: generate app passwords](https://help.yahoo.com/kb/SLN15241.html)                      |
| `icloud`   | [Apple: app-specific passwords](https://support.apple.com/en-us/102654)                       |
| `fastmail` | [Fastmail: app passwords](https://www.fastmail.help/hc/en-us/articles/360058752854)           |
| `zoho`     | [Zoho Mail help](https://www.zoho.com/mail/help/) (search "application-specific password")    |
| `gmx`      | [GMX help](https://support.gmx.com/) (search "IMAP" to enable access and set an app password) |
| `aol`      | [AOL: generate app passwords](https://help.aol.com/articles/Create-and-manage-app-password)   |

With a `provider` name, the server settings are filled in for you. Regional servers (e.g. Zoho EU)
only need `imap.host` set. For any other server, look up its "IMAP settings" and set
`imap.host`, `port` and `secure` yourself.

### d) An AI API key

One key is enough. You can use a different provider for each AI role.

| Provider      | Create a key                                                                       | Pick a model ID                                                  |
| ------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OpenAI        | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)               | [Models](https://platform.openai.com/docs/models)                |
| Anthropic     | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | [Models](https://docs.anthropic.com/en/docs/about-claude/models) |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey)                   | [Models](https://ai.google.dev/gemini-api/docs/models)           |

For the **gatekeeper** (spam/promotion classifier) and the optional **scheduler** (finds
meetings), a small, cheap model is enough. For the **analyst** (summaries and translation), use a
stronger one.

### e) Only if you use email reports: a sending account

Reports are sent from an account you choose, to an address that is **not** monitored. Pick one
(`delivery.email.oauth` or `delivery.email.smtp`, not both):

- **Recommended: Gmail or Microsoft with a send-only sign-in** (`delivery.email.oauth`). No password
  is stored. It reuses the OAuth app from step 2a / 2b with `gmail.send` (Gmail) or `Mail.Send`
  (Microsoft) added, and creates a **separate** sign-in that can only send, never read. The
  sending account can also be one of your monitored accounts: its read sign-in stays read-only.
  You sign in with `mail-me auth --email-channel` in step 4.
- **SMTP with an app password** (`delivery.email.smtp`), only for providers without OAuth. Avoid it
  for Gmail: a Gmail app password can read, send and delete all your mail, and it sits in `.env`.
  With SMTP you don't need `gmail.send`.

Skip this if you only use Telegram.

### f) Only if you use Telegram: a bot token

Create a bot with @BotFather by following
[Obtain your bot token](https://core.telegram.org/bots/tutorial#obtain-your-bot-token) in the official tutorial. Keep the token for step 3.

## Step 3: Create `config.json` and `.env`

You need **both** files. They are git-ignored, so your personal data and secrets are never committed.

| File          | What it holds                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `config.json` | Settings: accounts, OAuth app IDs, delivery channels, AI models, rules. **No secrets.**                               |
| `.env`        | Secrets only: API keys, OAuth client secret, passwords, bot token. `config.json` refers to them **by variable name**. |

OAuth sign-ins are secrets too, but they are not in `.env`: `mail-me auth` saves them in
`data/grants/` (step 4).

```bash
cp config.example.json config.json
cp .env.example .env
```

### Edit `config.json`

**`timezone`**: your IANA time zone, e.g. `"Asia/Ho_Chi_Minh"` or `"Europe/Berlin"`. Meeting times
without a stated zone use it. Docker containers run in UTC, so set it.

**`auth`** (only if you have Gmail or Microsoft accounts with OAuth):

| Field                      | Example                             | Meaning                                                     |
| -------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `grants_dir`               | `"data/grants"`                     | Where sign-ins are stored (default). Keep it inside `data/` |
| `google.client_id`         | `"1234…apps.googleusercontent.com"` | From step 2a                                                |
| `google.client_secret_env` | `"GOOGLE_OAUTH_CLIENT_SECRET"`      | **Name** of the `.env` variable holding the client secret   |
| `microsoft.client_id`      | `"00000000-…"`                      | From step 2b                                                |
| `microsoft.tenant`         | `"common"`                          | Default; set your tenant ID for a single-organization app   |

Remove a block you don't use.

**`accounts`**: one entry per mailbox account to monitor.

| Field            | Example                    | Meaning                                                                                                                                                                             |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `"school"`                 | Short unique name (letters, digits, `-`, `_`). Used in `mail-me auth <id>`                                                                                                          |
| `label`          | `"School"`                 | Shown on each report so you know where it came from                                                                                                                                 |
| `email`          | `"student@university.edu"` | The account's address                                                                                                                                                               |
| `provider`       | `"gmail"`                  | A [preset](#c-other-providers-app-password): `gmail`, `microsoft`, `yahoo`, `icloud`, `fastmail`, `zoho`, `gmx`, `aol`. Omit for any other server                                   |
| `auth`           | `"oauth"`                  | Optional. `gmail` defaults to `"oauth"` (`"password"` is possible but not recommended); `microsoft` is OAuth only; other providers use `"password"`                                 |
| `imap`           | `{ "password_env": … }`    | **Password accounts only.** `password_env` names the `.env` variable with the app password; `host`, `port`, `secure` and `user` come from the preset, or set them for other servers |
| `mailboxes`      | `["INBOX"]`                | Folders (Gmail: labels) to watch (optional, default `INBOX`)                                                                                                                        |
| `lookback_hours` | `0`                        | On the first start, also process mail from the last N hours (optional)                                                                                                              |

Examples:

```jsonc
// Gmail with read-only OAuth: no password anywhere
{ "id": "school", "label": "School", "email": "student@university.edu", "provider": "gmail" }

// Outlook.com or Microsoft 365
{ "id": "work", "label": "Work", "email": "me@company.com", "provider": "microsoft" }

// Yahoo with an app password: servers come from the preset
{ "id": "yahoo", "email": "me@yahoo.com", "provider": "yahoo", "imap": { "password_env": "YAHOO_IMAP_PASSWORD" } }

// Any other IMAP server
{ "id": "uni", "email": "me@uni.edu",
  "imap": { "host": "mail.uni.edu", "port": 993, "secure": true, "user": "me", "password_env": "UNI_IMAP_PASSWORD" } }
```

(`config.json` is plain JSON: the `//` comments above are only for this guide.)

**`delivery`**: both channels are optional; **enable at least one**. Settings of a disabled
channel are ignored.

| Field                    | Meaning                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email.enabled`          | `true` to receive reports by email                                                                                                                                                                                                             |
| `email.to`               | Where reports go. **Must not be one of the monitored mailboxes**, or mail-me would read its own reports. Startup refuses it (case, `+tags` and Gmail dots are ignored when comparing). Use your primary inbox and monitor your other accounts. |
| `email.oauth`            | Send with a send-only sign-in (recommended): `provider` (`"gmail"` or `"microsoft"`), `user` (the sending address), optional `from` (e.g. `"Mail-Me <me@gmail.com>"`)                                                                          |
| `email.smtp`             | Or send over SMTP with a password: `user`, `password_env`, optional `from`, and either `provider` (a preset) or `host` / `port` / `secure`. Set exactly one of `oauth` and `smtp`                                                              |
| `telegram.enabled`       | `true` to receive reports on Telegram (see step 5)                                                                                                                                                                                             |
| `telegram.bot_token_env` | **Name** of the `.env` variable holding the bot token                                                                                                                                                                                          |
| `telegram.chat_id`       | Your chat ID as a string (see step 5)                                                                                                                                                                                                          |

The example file ships with both channels **disabled**, so mail-me refuses to start until you
enable one.

**`ai`**:

| Field                    | Meaning                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gatekeeper` / `analyst` | Each has a `provider` (`openai`, `anthropic` or `google`), a `model` ID, and `api_key_env` (a `.env` variable name)                                           |
| `analyst.style`          | `"brief"` (default: short, phone-friendly reports) or `"detailed"` (the longer format). See [Reports](#reports)                                               |
| `scheduler`              | Finds meetings and plans ([Reports](#reports)). Same fields as above plus `enabled`. Leave it out, or set `"enabled": false`, to turn it off                  |
| `target_language`        | Language for the summaries, e.g. `"Vietnamese"`, `"English"`                                                                                                  |
| `prices`                 | Optional cost overrides per model ID, in USD per million tokens: `{ "my-model": { "input_per_mtok": 0.5, "output_per_mtok": 1.5 } }`. See [AI cost](#ai-cost) |

For example, to use Gemini for classification:

```json
"gatekeeper": { "provider": "google", "model": "<gemini model id>", "api_key_env": "GOOGLE_GENERATIVE_AI_API_KEY" }
```

If Anthropic replies "This API key is not scoped to a workspace", either create a workspace-scoped key in the Anthropic Console, or add `"workspace_id_env": "ANTHROPIC_WORKSPACE_ID"` to the `anthropic` role(s) and put the workspace ID in `.env`.

**`calendar.outlook_host`** (optional): `"outlook.live.com"` (default, personal Outlook) or
`"outlook.office.com"` (work or school Microsoft 365, where Teams meetings live). Used by the
"Add to Outlook calendar" links.

**`rules`** (optional):

| Field                  | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `whitelist_domains`    | Senders from these domains (and their subdomains) are always important, with no AI call                   |
| `drop_keywords`        | Whole words matched in the **subject or sender only**. A match is skipped as a promotion, with no AI call |
| `confidence_threshold` | Spam/promotion verdicts below this confidence (default 0.7) are forwarded anyway                          |

Everything else is optional and has sensible defaults:

- `schedule.poll_interval_seconds` (300)
- `delivery.max_attempts` (10)
- `limits.*`: `max_body_chars` (12000, text sent to the AI), `llm_concurrency` (2 AI calls at a time), `excerpt_chars` (600; brief reports cap the excerpt at 300 characters)
- `storage.path` (`data/mail-me.db`) and `storage.retention_days` (90)
- `logging.level`

The full reference is [config.schema.md](specs/002-oauth-providers-calendar/contracts/config.schema.md)
(changes since [001](specs/001-ai-email-assistant/contracts/config.schema.md)).

### Edit `.env`

Put one line per secret, using exactly the variable names from your `config.json`:

```bash
# ai.*.api_key_env
OPENAI_API_KEY=sk-...
# auth.google.client_secret_env (only with Gmail OAuth)
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
# delivery.telegram.bot_token_env (only if you use Telegram)
TELEGRAM_BOT_TOKEN=123456789:AA...
# delivery.email.smtp.password_env (only for email reports over SMTP)
# SMTP_PASSWORD=...
# accounts[].imap.password_env (only for password accounts, e.g. Yahoo)
# YAHOO_IMAP_PASSWORD=abcd efgh ijkl mnop
```

Write values **without quotes** and keep comments on their own lines. Some Docker tools
(`docker run --env-file`) take everything after `=` literally, so `"…"` or a trailing `# …`
would become part of the secret.

**Adding a second account:** add another object to `accounts` with its own `id`. OAuth accounts
need only a sign-in (step 4); password accounts need a new `password_env` name and that line in `.env`.

## Step 4: Sign in your Gmail / Outlook accounts

Skip this if all your accounts use passwords and you don't send email reports with OAuth.

Run the sign-in once per OAuth account, using its `id`:

```bash
npm ci && npm run auth -- school            # Node
docker compose run --rm -p 127.0.0.1:53682:53682 mail-me auth school --listen 0.0.0.0   # Docker
```

**Gmail:** the command prints a link. Open it in a browser where you can sign in to that account.
The consent screen must ask **only** to read your email (and nothing about sending, deleting or
your calendar); if it asks for more, stop and check step 2a. After you approve:

- If the browser runs on the same machine, the command finishes by itself.
- If mail-me runs on a server without a browser, the browser ends on a page that does not load
  (`127.0.0.1:53682 refused to connect`). That is expected: copy that page's **full address** and
  paste it into the terminal.

**Microsoft:** the command prints a short code. On any device, open
[microsoft.com/devicelogin](https://microsoft.com/devicelogin), enter the code and sign in. The
consent screen must ask only to read your mail and profile. No port is needed:
`docker compose run --rm mail-me auth work`.

**Email reports with OAuth:** sign in the sending account (`delivery.email.oauth.user`) the same
way, with `mail-me auth --email-channel`. The consent screen must ask only to send email (Gmail
also asks for your address). That grant can only send. If Google says the scope is not allowed,
add `gmail.send` under **Data access** ([step 2a](#a-gmail-register-your-own-google-oauth-app), item 4).

On success you see `✓ Signed in … with read-only mail access. Saved to data/grants/school.read.json`.
Nothing is saved if you signed in with a different account than the config says.

Useful extras:

- `mail-me auth --status` lists every sign-in and when it was last renewed.
- You can sign in on your laptop and copy `data/grants/` to the server. Keep the files private
  (`chmod 600 data/grants/*`), and keep `data/` on a Linux filesystem: on a Windows drive such as
  `/mnt/c` file permissions cannot be restricted and mail-me refuses the files.
- Access renews automatically. Run the command again only if the log says the sign-in was
  revoked or expired.

## Step 5 (only if you use Telegram): Find your chat ID

1. Open your new bot in Telegram and send it `/start`.
2. With `TELEGRAM_BOT_TOKEN` set in `.env`, run:

   ```bash
   npm ci && npm run telegram-chat-id             # Node
   docker compose run --rm mail-me telegram-chat-id   # Docker
   ```

   No Compose plugin? See [Without Docker Compose](#without-docker-compose).

3. Copy the printed ID into `delivery.telegram.chat_id` (as a string, e.g. `"123456789"`), and set `delivery.telegram.enabled` to `true`.

## Step 6: Validate

```bash
# Node
npm ci
npm run check-config      # "Config OK" and each sign-in, or an error naming the bad field
npm run check-delivery    # sends a test report to every enabled channel

# Docker
docker compose build
docker compose run --rm mail-me check-config
docker compose run --rm mail-me check-delivery
```

`check-config` also fails with the command to run when an OAuth account is not signed in yet.
Fix anything reported, and re-run until both commands succeed.

## Step 7: Run and host

### Option A: Docker Compose (recommended)

```bash
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
docker compose up -d --build
docker compose logs -f mail-me
```

- It restarts automatically (`restart: unless-stopped`), including after a reboot once Docker starts.
- `./data` holds the database **and your OAuth sign-ins**. Keep `storage.path` and `auth.grants_dir` at their defaults, back the folder up, and keep it private.
- Set `timezone` in `config.json` (or `TZ` in `docker-compose.yml`): containers run in UTC.
- To update: `git pull && docker compose up -d --build`.

#### Without Docker Compose

Plain `docker` works too. Every `docker compose run --rm mail-me <command>` in this guide becomes
`docker run --rm … mail-me <command>` with the same env file and mounts:

```bash
docker build -t mail-me .
mkdir -p data && sudo chown 1000:1000 data

# one-off commands: auth, telegram-chat-id, check-config, check-delivery, run-once
docker run --rm -it --env-file .env -p 127.0.0.1:53682:53682 \
  -v "$PWD/config.json:/app/config.json:ro" -v "$PWD/data:/app/data" \
  mail-me auth school --listen 0.0.0.0

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

`config.json`, `.env` and `data/` are read from `WorkingDirectory`. To use another config path, add
`Environment=MAIL_ME_CONFIG=/path/to/config.json`.

### Option C: Single passes from cron

If you prefer a scheduler you already run, `run-once` polls every account once and exits:

```cron
*/5 * * * * cd /home/youruser/mail-me && /usr/bin/node dist/index.js run-once >> mail-me.log 2>&1
```

On the first start, only mail that arrives **after** startup is processed (unless you set `lookback_hours`).

## Step 8: Check that it works

1. Send a test email to a monitored mailbox, for example "Assignment 3 due Friday 5pm, submit via portal".
2. Within one poll interval (5 minutes by default), an `[AI Summary] …` report arrives on each
   enabled channel. It should be in your target language, show who the email was sent to
   (`👥 To: you …`), and include the action item and deadline. Gmail and Outlook reports end with
   an **Open original** link that opens the message in your webmail.
3. Send yourself "Project sync on Thursday at 14:00 for 45 minutes, Teams link: https://teams.microsoft.com/l/…".
   The report shows `📅 Project sync — Thu …, 14:00–14:45` with **Add to Google Calendar** and
   **Add to Outlook calendar** links, and the email report has an `event.ics` attachment. Open a
   link: a prefilled event appears. Nothing is added until you save it.
4. Send an email whose subject contains one of your drop keywords (e.g. "50% discount"). It is
   **not** reported, and the log shows `"decision":"DROP_KEYWORD","outcome":"SKIPPED"`.
5. `docker compose logs mail-me` shows an `ai call` line per AI call with its `costUsd`, and an
   `email reported` line with the email's total.
6. Restart the service. No duplicate reports arrive.

## Reports

**Brief** (default, `ai.analyst.style: "brief"`):

```text
🔴 [AI Summary] Assignment 3                           ← 🔴 only when urgent
📥 School · ✉️ Prof. Nguyen <prof@university.edu>
👥 To: you, Alice and 28 more · Cc: TA Office

TL;DR: Assignment 3 is due Friday 17:00 via the portal.
• Covers chapters 5–7
• Late work loses 10% per day
✅ Actions
☐ Submit assignment 3 — Friday 17:00

📅 Office hours — Thu 6 Nov, 14:00–15:00 (Asia/Ho_Chi_Minh)
   📍 Room 204
   Add to Google Calendar · Add to Outlook calendar

<short excerpt of the original>
Open original
```

- The TL;DR has at most 2 sentences (about 40 words), there are at most 3 one-line key points, and
  the excerpt is at most 300 characters. These limits are enforced in code, so a chatty model
  cannot break them. A typical report fits in one Telegram message.
- With no action items, the report shows a single `Action needed: No` line.
- **Detailed** (`"detailed"`) keeps the longer format: a fuller summary, up to 10 key points and a
  600-character excerpt.

**Recipients.** The `👥` line shows the To and Cc recipients (5 per list, then "and N more"), with
your monitored address shown as "you". If you got the email through Bcc, an alias or a forward,
it says `received at <your address>`.

**Events.** The Scheduler looks for meetings, calls, interviews, classes, exams, appointments and
other plans in important emails only (never in spam or promotions). Calendar invitations are read
directly, without AI.

- Relative dates ("next Tuesday at 3pm") are worked out from the email's sent date; times without a
  zone use your `timezone`. If the email states another zone, both are shown.
- Up to 3 events per email; the report says when more were left out.
- An event with no usable time shows "time not set", and cancelled or past events have no links.
- If event detection fails, the report still arrives, with "⚠ Event detection failed, check the email for dates".
- **mail-me never writes to your calendar and never asks for calendar permission.** You add the
  event yourself with a link or the `.ics` file (which also works in Apple Calendar and Teams).
  Meeting links are shown as written in the email; mail-me does not open or vouch for them.

**Open original** appears for Gmail and Outlook accounts. It opens the message when you are signed
in to that account in your browser. If the message was deleted or moved, it may no longer open.

## AI cost

Every AI call logs one line, and every email logs its total:

```json
{"msg":"ai call","account":"school","role":"analyst","provider":"anthropic","model":"claude-haiku-5-5","tokensIn":1834,"tokensOut":212,"ms":2140,"costUsd":0.000289}
{"msg":"email reported","account":"school","aiCalls":3,"tokens":{"input":2410,"output":398},"costUsd":0.000512, …}
```

- Costs are **estimates**: tokens × the model's public list price. The built-in price list is dated
  (`pricesAsOf` in the startup log line) and goes out of date; discounts, caching and taxes are not
  included.
- Emails handled by rules alone log `"costUsd": 0`.
- A model without a known price logs `"costUsd": null` and one warning. Add its price under
  `ai.prices` in `config.json` (USD per million tokens), which also overrides built-in prices:

  ```json
  "prices": { "my-model": { "input_per_mtok": 0.5, "output_per_mtok": 1.5 } }
  ```

## Troubleshooting

| Symptom                                                                                  | Fix                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Invalid config: <field> — …`                                                            | The message names the exact field. Fix it in `config.json`, or set the missing variable in `.env`                                                                                                            |
| `delivery — enable at least one channel`                                                 | Set `delivery.email.enabled` or `delivery.telegram.enabled` to `true`                                                                                                                                        |
| `accounts[0] ("school"): not signed in. Run: mail-me auth school`                        | Run that command ([step 4](#step-4-sign-in-your-gmail--outlook-accounts))                                                                                                                                    |
| Log: `sign-in revoked or expired, run mail-me auth <id>`                                 | Run the command again. Mail that arrived meanwhile is still reported. If this happens every week, your Google app is still in _Testing_: publish it ([step 2a](#a-gmail-register-your-own-google-oauth-app)) |
| Google: `Error 401: invalid_client` / "The OAuth client was not found"                   | `auth.google.client_id` doesn't match a client in your Cloud project. Copy it again from **Clients**. A client created minutes ago can take a while to start working: wait and retry                         |
| Google: `Error 403: access_denied` / "has not completed the Google verification process" | Your app is in _Testing_ and this account is not a test user. Publish the app ([step 2a](#a-gmail-register-your-own-google-oauth-app), item 6), or add the address under **Audience → Test users**           |
| `signed in as other@…, but the config says …`                                            | You approved with another account. Run `mail-me auth <id>` again and pick the right account (Gmail prefills it)                                                                                              |
| `the grant was issued to a different OAuth app`                                          | You changed `client_id`. Sign in again                                                                                                                                                                       |
| Sign-in: "administrator must approve this app"                                           | Your Microsoft 365 organization blocks user consent. See [admin approval](#microsoft-365-admin-approval)                                                                                                     |
| Browser shows `127.0.0.1 refused to connect` after Google consent                        | Expected when mail-me runs on another machine: copy the page's full address and paste it into the terminal                                                                                                   |
| `can be read by other users. Run: chmod 600 …`                                           | Run the `chmod`. On a Windows drive (`/mnt/c`) move `data/` to the Linux filesystem                                                                                                                          |
| `Microsoft turned off password sign-in`                                                  | Use `"provider": "microsoft"` with OAuth; Outlook and Microsoft 365 no longer accept passwords                                                                                                               |
| Password accounts: IMAP `auth failed` / `AUTHENTICATIONFAILED`                           | Use an app password, not your normal password. Check that IMAP is allowed for the account                                                                                                                    |
| `no price for model, cost unknown`                                                       | Add the model under `ai.prices` ([AI cost](#ai-cost)), or ignore it: only the estimate is missing                                                                                                            |
| `unknown command: docker compose` or `unknown flag: --rm`                                | The Compose plugin is not installed. Install it (see [Prerequisites](#prerequisites)) or use [plain `docker run`](#without-docker-compose)                                                                   |
| `not a Telegram bot token` or `telegram getUpdates: 404 Not Found`                       | The token in `.env` is wrong or has quotes around it. Write it as `TELEGRAM_BOT_TOKEN=123456789:AA...`, with no quotes                                                                                       |
| Telegram `chat not found`                                                                | Send `/start` to your bot first, then check `chat_id`                                                                                                                                                        |
| Telegram `Unauthorized`                                                                  | The bot token is wrong or was revoked. Get a new one from @BotFather                                                                                                                                         |
| Meeting times are off by some hours                                                      | Set `timezone` in `config.json` (Docker runs in UTC)                                                                                                                                                         |
| Nothing arrives                                                                          | Check the logs (`docker compose logs mail-me` or `journalctl -u mail-me`). Each email logs one JSON line with its `decision` and `outcome`                                                                   |
| Permission error on `/app/data` in Docker (`EACCES`, `SQLITE_CANTOPEN`)                  | `./data` is not writable by uid 1000. Run `sudo chown 1000:1000 data`                                                                                                                                        |

## Upgrading from 001

Your existing `config.json`, `.env` and database keep working: the database is upgraded on the
first start, and no mail is replayed or skipped. To replace a Gmail app password with read-only OAuth:

1. Register your Google OAuth app ([step 2a](#a-gmail-register-your-own-google-oauth-app)) and add the `auth.google` block.
2. In the account, set `"provider": "gmail"` and remove the whole `imap` block. Remove its password from `.env`.
3. Run `mail-me auth <id>` and restart.
4. **Revoke the old app password** at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).

To send email reports without a password too, replace `delivery.email.smtp` with `delivery.email.oauth`
and run `mail-me auth --email-channel`.

---

## Privacy

- **Mailboxes are read-only.** Gmail and Microsoft accounts grant only read access (`gmail.readonly`, `Mail.Read`), so the provider itself prevents any change. Other mailboxes are opened read-only over IMAP (`EXAMINE`, bodies fetched with `BODY.PEEK`).
- **Sign-ins (grants)** are stored in `data/grants/` with owner-only permissions and are never logged. You can revoke them at any time: Google at [myaccount.google.com/connections](https://myaccount.google.com/connections), Microsoft at [account.live.com/consent/Manage](https://account.live.com/consent/Manage) or [myapps.microsoft.com](https://myapps.microsoft.com) for work accounts. The email channel's grant can only send.
- **No calendar access.** mail-me never asks for calendar permission. Calendar links send the event details to Google or Microsoft only when **you** open them.
- The cleaned email text (truncated to `limits.max_body_chars`) is sent to the AI provider you configured, and nowhere else.
- Reports go only to the channels you enabled. **Telegram bot chats are stored on Telegram's
  servers and are not end-to-end encrypted.** Anything in a Telegram report, including recipient
  addresses, is visible to Telegram.
- The local database holds message identifiers, sender, subject, the decision, token counts and
  cost and, while delivery is pending, the report itself (summary, recipients, events and a short
  excerpt). It never holds full bodies. Records are deleted after `storage.retention_days` (default 90).
- Logs are structured JSON. They contain each decision, token usage and estimated cost, but no
  email bodies, and secrets (including OAuth tokens) are redacted.
- Email content is treated as untrusted. It goes to the AI only inside a delimited data block,
  every AI response is schema-validated, every rendered value is escaped, and links are built by code.

## Commands

| Command                            | What it does                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run start`                    | Poll all accounts on the configured interval (dev, via tsx)                                                     |
| `npm run start:prod`               | Same, from the built `dist/` (after `npm run build`)                                                            |
| `npm run run-once`                 | One pass over all accounts, then exit                                                                           |
| `npm run check-config`             | Validate the config, secrets and sign-ins                                                                       |
| `npm run check-delivery`           | Send a test report to every enabled channel                                                                     |
| `npm run auth -- <id>`             | Sign in an OAuth account with read-only mail access (`--port 53682`, `--listen 0.0.0.0` inside Docker)          |
| `npm run auth -- --email-channel`  | Sign in the email channel's sending account (send-only)                                                         |
| `npm run auth -- --status`         | List OAuth sign-ins and when they were last renewed                                                             |
| `npm run telegram-chat-id`         | List chats that have messaged your bot                                                                          |
| `npm run eval:gatekeeper -- <dir>` | Measure filtering on labelled `.eml` files in `<dir>/{important,promotion,spam}/`. This makes real AI calls     |
| `npm run eval:scheduler -- <dir>`  | Measure event detection on `<dir>/with-events/*.eml` (+ `.expected.json`) and `<dir>/no-events/`. Real AI calls |

In Docker, use the same command names: `docker compose run --rm mail-me <command>`. Use `--config <path>` or
`MAIL_ME_CONFIG` to point to another config file.

## Development

```bash
npm test              # unit, contract and integration tests (fakes, no network)
npm run typecheck && npm run lint
docker compose --profile test up -d greenmail && npm run test:e2e   # real IMAP + SMTP
```

The design documents (spec, plan, contracts, data model) are in `specs/001-ai-email-assistant/`
and `specs/002-oauth-providers-calendar/`.

## License

MIT
