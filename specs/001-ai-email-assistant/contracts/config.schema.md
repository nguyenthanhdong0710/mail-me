# Contract: Configuration (`config.json`)

Validated with zod at startup. Unknown keys → error. Secrets are referenced by **environment variable name** (`*_env`), never inline.

```json
{
  "accounts": [
    {
      "id": "school",
      "label": "School",
      "email": "student@university.edu",
      "imap": { "host": "imap.gmail.com", "port": 993, "secure": true, "user": "student@university.edu", "password_env": "SCHOOL_IMAP_PASSWORD" },
      "mailboxes": ["INBOX"],
      "lookback_hours": 0
    }
  ],
  "delivery": {
    "email": {
      "enabled": true,
      "to": "my_primary_email@gmail.com",
      "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "my_primary_email@gmail.com", "password_env": "SMTP_PASSWORD", "from": "Mail-Me <my_primary_email@gmail.com>" }
    },
    "telegram": {
      "enabled": true,
      "bot_token_env": "TELEGRAM_BOT_TOKEN",
      "chat_id": "123456789"
    },
    "max_attempts": 10
  },
  "ai": {
    "gatekeeper": { "provider": "openai", "model": "<small-model-id>", "api_key_env": "OPENAI_API_KEY" },
    "analyst":    { "provider": "anthropic", "model": "<strong-model-id>", "api_key_env": "ANTHROPIC_API_KEY" },
    "target_language": "Vietnamese"
  },
  "rules": {
    "whitelist_domains": ["university.edu", "mycompany.com"],
    "drop_keywords": ["sale", "discount", "% off"],
    "confidence_threshold": 0.7
  },
  "schedule": { "poll_interval_seconds": 300 },
  "limits": { "max_body_chars": 12000, "llm_concurrency": 2, "excerpt_chars": 600 },
  "storage": { "path": "data/mail-me.db", "retention_days": 90 },
  "logging": { "level": "info" }
}
```

## Rules
| Path | Type | Required | Default | Validation |
|---|---|---|---|---|
| accounts | array | ✔ | — | ≥ 1, unique `id` |
| accounts[].imap.port | int | | 993 | 1–65535 |
| accounts[].imap.secure | bool | | true | `false` logs a warning |
| accounts[].mailboxes | string[] | | `["INBOX"]` | |
| delivery | object | ✔ | — | **at least one channel `enabled: true`** |
| delivery.email.enabled | bool | | false | |
| delivery.email.to | email | if enabled | — | valid address. **MUST NOT match any `accounts[].email` or `accounts[].imap.user`** (see below) |
| delivery.email.smtp.* | object | if enabled | — | `from` defaults to `smtp.user` |
| delivery.telegram.enabled | bool | | false | |
| delivery.telegram.bot_token_env | string | if enabled | — | env var must be set. Format `<digits>:<token>` |
| delivery.telegram.chat_id | string | if enabled | — | numeric (may be negative for groups) or `@channelname` |
| delivery.max_attempts | int | | 10 | ≥ 1. Attempts per channel before giving up |
| ai.*.provider | enum | ✔ | — | `openai \| anthropic \| google` |
| ai.*.model | string | ✔ | — | non-empty |
| ai.*.api_key_env | string | ✔ | — | env var must be set |
| ai.target_language | string | ✔ | — | |
| rules.whitelist_domains | string[] | | `[]` | leading `@` is stripped. Matches the domain and its subdomains |
| rules.drop_keywords | string[] | | `[]` | case-insensitive, matched against subject and sender only |
| rules.confidence_threshold | number | | 0.7 | 0–1 |
| schedule.poll_interval_seconds | int | | 300 | ≥ 30 |
| limits.max_body_chars | int | | 12000 | ≥ 1000 |

## Loop-prevention address check (FR-021)
`normalize(addr)`: lowercase, strip `+tag` from the local part, and for `gmail.com`/`googlemail.com` also remove dots from the local part and map the domain to `gmail.com`.
If `normalize(delivery.email.to)` equals the normalized value of any `accounts[].email` or `accounts[].imap.user`, reject the config:

`Invalid config: delivery.email.to — "me@gmail.com" is also monitored by accounts[1] ("personal"). Reports would be read back in. Use an address that is not monitored.`

Aliases this check cannot see are caught at runtime by the self-sent marker (contracts/delivery.contract.md).

## Error format
`Invalid config: accounts[0].imap.password_env — environment variable "SCHOOL_IMAP_PASSWORD" is not set`

Exit code 2 for config errors.
