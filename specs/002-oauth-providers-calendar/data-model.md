# Data Model: Feature 002

Extends [001 data-model](../001-ai-email-assistant/data-model.md). Only new or changed entities
are listed. Types live in `src/domain/types.ts` unless noted.

## Mail Provider Preset (new, `src/config/providers.ts`, static)

| Field | Type | Notes |
|---|---|---|
| name | `"gmail" \| "microsoft" \| "yahoo" \| "icloud" \| "fastmail" \| "zoho" \| "gmx" \| "aol" \| "custom"` | |
| authMethods | `("oauth" \| "password")[]` | first entry is the default |
| oauthProvider | `"google" \| "microsoft" \| null` | which OAuth endpoints and API |
| imap | `{ host, port, secure } \| null` | `null` for API-only providers (microsoft) |
| smtp | `{ host, port, secure } \| null` | used by the email channel's password transport |
| webLink | `"gmail-msgid" \| "graph" \| null` | how "Open original" is built (research R7) |

Validation: `custom` requires `imap.host`. Explicit account settings override preset fields.

## Monitored Account (changed, `AccountConfig`)

| Field | Change | Notes |
|---|---|---|
| provider | **new** | preset name, default `custom` |
| auth | **new** | `"oauth" \| "password"`, default = preset default; must be in `authMethods` (FR-108) |
| imap | changed | only for `password`; `host/port/secure` default from preset, `user` defaults to `email`, `password_env` required |
| grant | **new** | runtime: `{ path, provider }` for `oauth` accounts, resolved at startup |
| email, id, label, mailboxes, lookbackHours | unchanged | `mailboxes` names: IMAP folder, Gmail label (`INBOX` → label `INBOX`), Graph folder (`INBOX` → well-known `inbox`) |

## OAuth Grant (new, file `<grants_dir>/<name>.json`, secret)

| Field | Type | Notes |
|---|---|---|
| version | `1` | file format version |
| provider | `"google" \| "microsoft"` | |
| purpose | `"read" \| "send"` | monitored accounts are always `read`; the email channel is `send` |
| address | string | confirmed with the provider at sign-in; must match config |
| scopes | string[] | as granted (checked against the purpose at startup) |
| clientId | string | the OAuth app that issued it; a mismatch with config → "sign in again" |
| tenant | string? | Microsoft only |
| refreshToken | string | secret; never logged |
| createdAt / updatedAt | ISO string | `updatedAt` changes when a rotated refresh token is saved |

File names: `<account-id>.read.json`, `email-channel.send.json`. Mode `0600`, dir `0700`.

**States** (in memory, per grant):

```text
missing ──(mail-me auth)──▶ valid ──(access token expiry)──▶ refreshing ──ok──▶ valid
                              │                                  │
                              │                         invalid_grant / revoked
                              ▼                                  ▼
                        (startup check)                       revoked ──(mail-me auth)──▶ valid
```

`missing` and wrong address/client/scopes fail startup (FR-108). `revoked` fails only that
account's polls (or the email channel's deliveries, which retry per 001), logged with the fix
command (FR-104).

## Mailbox State (changed, table `mailbox_state`)

| Column | Change | Notes |
|---|---|---|
| uid_validity | INTEGER → **TEXT** | "generation": IMAP UIDVALIDITY, `gmail:<label>`, or Graph folder ID |
| last_seen_uid | **renamed `cursor`, TEXT** | opaque per source (research R2): IMAP UID, `h:<historyId>@<ms>` / `t:<ms>`, or Graph ISO time |

## Message Key (changed)

`{ accountId, mailbox, uidValidity: string, uid: string }`. `uid` is the IMAP UID, Gmail message
ID or Graph immutable ID. Tables `processed_messages`, `pending_reports`, `deliveries` change
`uid_validity` and `uid` to TEXT in migration 3 (values kept via `CAST`).

## Raw Message (changed, `RawMessage` port type)

| Field | Change |
|---|---|
| uid | number → **`id: string`** |
| cursor | **new**: cursor to persist after this message settles |
| source, internalDate | unchanged |
| webLink | **new, optional**: provider-supplied link (Graph `webLink`) |

## Incoming Email (changed)

| Field | Change | Notes |
|---|---|---|
| to, cc | **new** | `Address[]`, names sanitized and capped |
| deliveredTo | **new** | the account address that received it |
| addressedToYou | **new** | `boolean`: deliveredTo appears in To or Cc (`sameMailbox`) |
| webLink | **new** | `string \| null` (research R7, host allowlist applied) |
| calendarParts | **new** | raw `text/calendar` contents (max 3, 64 KB each) for the invitation parser |
| sentAt | **new** | the email's `Date` header with its original offset (for relative dates) |

## Detected Event (new)

| Field | Type | Rule |
|---|---|---|
| title | string ≤ 120 | required |
| status | `"new" \| "rescheduled" \| "cancelled"` | |
| source | `"invitation" \| "ai"` | |
| timeSet | boolean | false → "time not set", no links (FR-116) |
| start / end | ISO instant (UTC) | `end` = start + 60 min when only start is known; `end > start` |
| allDay | boolean | all-day: `start`/`end` are dates (`YYYY-MM-DD`), end exclusive |
| timezone | IANA string | stated zone, else config `timezone` |
| location | string ≤ 200 \| null | |
| meetingUrl | `https:` URL ≤ 500 \| null | shown as written, never fetched |
| links | `{ google, outlook } \| null` | null when `!timeSet`, cancelled, or `end` ≤ now (FR-117, US4-9) |

At most 3 per report; `eventsOmitted: number` records the rest.

## Report (changed, `Report`, stored as JSON in `pending_reports`)

| Field | Change |
|---|---|
| style | **new**: `"brief" \| "detailed"` |
| original.to, original.cc | **new**: `{ shown: Address[]; more: number }` each |
| original.deliveredTo, original.addressedToYou | **new** |
| original.webLink | **new**: `string \| null` |
| events | **new**: `DetectedEvent[]` |
| eventsOmitted | **new**: number |
| schedulerFailed | **new**: boolean; logged, and rendered as a one-line "⚠ Event detection failed" notice (constitution III) |

Renderers treat missing new fields (pending reports written by 001) as: `style: "detailed"`, no
recipients block, no link, no events.

## AI Usage Record (new, log only)

| Field | Type |
|---|---|
| role | `"gatekeeper" \| "analyst" \| "scheduler"` |
| provider, model | string |
| tokensIn, tokensOut | integer |
| ms | integer |
| costUsd | number \| null (null = unknown price) |

Per-email aggregate: `tokens: { input, output }`, `costUsd` (sum; null if any call unknown),
`aiCalls`. `processed_messages` gains `cost_usd REAL NULL`.

## Model Price (new)

`{ input_per_mtok: number ≥ 0, output_per_mtok: number ≥ 0 }` in USD per million tokens. Sources:
`ai.prices` in config (wins) → built-in table `src/agents/prices.ts` (exact ID, then longest prefix).

## Migration 3 (summary)

1. Rebuild `mailbox_state` with `uid_validity TEXT`, `cursor TEXT` (from `CAST(last_seen_uid AS TEXT)`).
2. Rebuild `processed_messages`, `pending_reports`, `deliveries` with `uid_validity TEXT`, `uid TEXT`,
   keeping primary keys and indexes.
3. `ALTER TABLE processed_messages ADD COLUMN cost_usd REAL`.
4. `report_json` written by 001 holds numeric `key.uidValidity` / `key.uid`; the store rebuilds
   `report.key` from the row's columns when reading, so old pending reports still deliver.
