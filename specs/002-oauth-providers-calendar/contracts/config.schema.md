# Contract: Config Schema Changes (002)

Extends [001 config.schema](../../001-ai-email-assistant/contracts/config.schema.md). Every
feature-001 config remains valid. Validation runs at startup and in `check-config`; errors name the
field path and the next step (FR-108, FR-124).

## Root

```jsonc
{
  "timezone": "Asia/Ho_Chi_Minh",          // NEW, IANA; default: process zone. Used by the Scheduler.
  "auth": {                                 // NEW, required only if any OAuth is used
    "grants_dir": "data/grants",            // default; must not be inside the repo's tracked files
    "google":    { "client_id": "…apps.googleusercontent.com", "client_secret_env": "GOOGLE_OAUTH_CLIENT_SECRET" },
    "microsoft": { "client_id": "00000000-…", "tenant": "common" }   // tenant default "common"
  },
  "accounts": [ … ],
  "delivery": { … },
  "ai": { … },
  "calendar": { "outlook_host": "outlook.live.com" }  // NEW; or "outlook.office.com"
}
```

Rules:
- `auth.google` is required when any account or the email channel uses Google OAuth;
  `auth.microsoft` likewise for Microsoft. Missing → `auth.google — required because accounts[0] ("school") uses OAuth with gmail`.
- `timezone` must be a value of `Intl.supportedValuesOf("timeZone")` or `"UTC"`.

## Accounts

```jsonc
// OAuth (default for gmail and microsoft): no imap block, no password
{ "id": "school", "label": "School", "email": "student@university.edu", "provider": "gmail" },
{ "id": "work",   "email": "me@company.com", "provider": "microsoft", "auth": "oauth" },

// Password with a preset: host/port come from the preset, user defaults to email
{ "id": "yahoo", "email": "me@yahoo.com", "provider": "yahoo",
  "imap": { "password_env": "YAHOO_IMAP_PASSWORD" } },

// Any other server (feature-001 shape, provider omitted = "custom")
{ "id": "uni", "email": "me@uni.edu",
  "imap": { "host": "mail.uni.edu", "port": 993, "secure": true, "user": "me", "password_env": "UNI_IMAP_PASSWORD" } }
```

| Field | Type | Default | Rule |
|---|---|---|---|
| provider | enum of presets | `"custom"` | |
| auth | `"oauth" \| "password"` | preset default | must be supported by the preset (`microsoft` + `password` → error explaining Microsoft disabled password sign-in) |
| imap | object | — | forbidden with `oauth`; required with `password` (`password_env` required; `host` required for `custom`) |

Startup checks for `oauth` accounts (FR-108): grant file `<grants_dir>/<id>.read.json` exists, is
`0600`, parses, `purpose == "read"`, `address` matches `email` (`sameMailbox`), `clientId` matches,
and the granted scopes include the required read scope and **no** scope that can change, send or
delete mail or touch calendars (blocklist; providers may add `openid`/`profile`/`email`). Failure message:
`accounts[0] ("school"): not signed in. Run: mail-me auth school` (or "signed in as other@…", or
"grant was issued to a different OAuth app").

## Delivery

```jsonc
"delivery": {
  "email": {                                  // optional channel
    "enabled": false,
    "to": "me@example.com",
    "oauth": { "provider": "gmail", "user": "me@gmail.com", "from": "Mail-Me <me@gmail.com>" },  // NEW
    "smtp":  { … }                            // password alternative, unchanged (host may come from "provider")
  },
  "telegram": { "enabled": false, "bot_token_env": "TELEGRAM_BOT_TOKEN", "chat_id": "123456789" },
  "max_attempts": 10
}
```

Rules (FR-125–127):
- Settings of a disabled channel are not required and not validated beyond types.
- Enabled email channel requires `to` and **exactly one** of `oauth` / `smtp`.
- `oauth.provider`: `"gmail"` or `"microsoft"`; grant `<grants_dir>/email-channel.send.json` must
  exist with `purpose == "send"` and send-only scopes. Missing → `Run: mail-me auth --email-channel`.
- `smtp` gains optional `"provider"` (preset) so `host/port/secure` may be omitted.
- Neither enabled → `delivery — enable at least one channel: set delivery.email.enabled or delivery.telegram.enabled to true`.

## AI

```jsonc
"ai": {
  "gatekeeper": { "provider": "openai", "model": "gpt-5-mini", "api_key_env": "OPENAI_API_KEY" },
  "analyst":    { "provider": "anthropic", "model": "claude-haiku-5-5", "api_key_env": "ANTHROPIC_API_KEY",
                  "style": "brief" },          // NEW: "brief" (default) | "detailed"
  "scheduler":  { "enabled": true,             // NEW; omitted block = disabled
                  "provider": "openai", "model": "gpt-5-mini", "api_key_env": "OPENAI_API_KEY" },
  "target_language": "Vietnamese",
  "prices": {                                  // NEW, optional; USD per million tokens
    "my-local-model": { "input_per_mtok": 0, "output_per_mtok": 0 }
  }
}
```

- `ai.scheduler` with `enabled: false` needs no provider/model/key.
- `limits.excerpt_chars` default 600; in brief style the excerpt is capped at min(`excerpt_chars`, 300).

## Secrets (`.env`)

New names (by convention; config refers to them by name): `GOOGLE_OAUTH_CLIENT_SECRET`. No
mailbox password is needed for OAuth accounts. `SMTP_PASSWORD` is only for a password-based email
channel. Grant files are secrets but live in `grants_dir`, not `.env`.
