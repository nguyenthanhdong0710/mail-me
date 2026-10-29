# Data Model: AI Email Assistant

## Domain types (in-memory)

### IncomingEmail
| Field | Type | Notes |
|---|---|---|
| accountId | string | from config `accounts[].id` |
| mailbox | string | default `INBOX` |
| uidValidity | bigint/number | from the IMAP mailbox |
| uid | number | unique within uidValidity |
| messageId | string \| null | RFC 5322 Message-ID |
| from | `{ name?: string; address: string }` | |
| subject | string | `"(no subject)"` if empty |
| receivedAt | Date | |
| text | string | cleaned, truncated body |
| truncated | boolean | |
| attachments | string[] | file names only |

### RuleDecision
`{ kind: "ALREADY_PROCESSED" } | { kind: "SELF_SENT" } | { kind: "WHITELIST", domain } | { kind: "DROP_KEYWORD", keyword } | { kind: "NEEDS_LLM" }`

### ClassificationResult (Gatekeeper output — see contracts/gatekeeper.contract.md)
| Field | Type | Validation |
|---|---|---|
| category | `"SPAM" \| "PROMOTION" \| "IMPORTANT"` | enum |
| confidence_score | number | 0 ≤ x ≤ 1 |
| reasoning | string | ≤ 300 chars |

**Effective category** = IMPORTANT if (category ≠ IMPORTANT and confidence < threshold) or the Gatekeeper failed.

### AnalysisResult (Analyst output — see contracts/analyst.contract.md)
| Field | Type | Validation |
|---|---|---|
| original_language | string | non-empty |
| summary | string | 1–1000 chars |
| key_points | string[] | 0–10 items |
| action_items | `{ action: string; deadline: string \| null }[]` | 0–10 items |
| requires_immediate_attention | boolean | |

The blueprint stored deadlines inline as `"Action 1 (Deadline)"`. They are now a separate `deadline` field so each channel can render it.

### Report
The channel-neutral result for one email. Its shape is defined in `contracts/delivery.contract.md`. Rendered by the email channel (HTML + text) and the Telegram channel (Telegram HTML).

## Persistent schema (SQLite)

### `mailbox_state`
| Column | Type | Notes |
|---|---|---|
| account_id | TEXT | PK part |
| mailbox | TEXT | PK part |
| uid_validity | INTEGER | |
| last_seen_uid | INTEGER | highest UID such that every UID ≤ it is recorded |
| updated_at | TEXT (ISO) | |

### `processed_messages`
| Column | Type | Notes |
|---|---|---|
| account_id | TEXT | PK part |
| uid_validity | INTEGER | PK part |
| uid | INTEGER | PK part |
| message_id | TEXT | indexed. Secondary dedup |
| sender | TEXT | address only |
| subject | TEXT | |
| decision | TEXT | `SELF_SENT \| WHITELIST \| DROP_KEYWORD \| LLM` |
| category | TEXT NULL | effective category (NULL for SELF_SENT) |
| confidence | REAL NULL | |
| outcome | TEXT | `FORWARDED \| SKIPPED \| FALLBACK_FORWARDED \| DELIVERY_FAILED` |
| tokens_in / tokens_out | INTEGER NULL | AI usage |
| processed_at | TEXT (ISO) | |

No body text is stored (Principle I). Rows older than `storage.retention_days` (default 90) are deleted at startup and once a day. The `mailbox_state` row and the UID PK prevent reprocessing even after the old rows are deleted.

### `pending_reports`
| Column | Type | Notes |
|---|---|---|
| account_id, uid_validity, uid | PK | same key as processed_messages |
| report_json | TEXT | serialized Report (summary + excerpt, no full body). Deleted once complete |
| created_at | TEXT (ISO) | |

### `deliveries`
| Column | Type | Notes |
|---|---|---|
| account_id, uid_validity, uid, channel | PK | channel = `email \| telegram` |
| status | TEXT | `PENDING \| DELIVERED \| GAVE_UP` |
| attempts | INTEGER | |
| parts_sent | INTEGER | Telegram split progress (0 for email) |
| external_id | TEXT NULL | sent Message-ID / Telegram message_id |
| last_error | TEXT NULL | redacted |
| next_attempt_at | TEXT NULL | honors Telegram `retry_after` |
| updated_at | TEXT (ISO) | |

Delivery rows are kept for retention-days for auditing, and then purged together with processed_messages.

### `meta`
`key TEXT PK, value TEXT`. Holds `install_id` (UUID for the self-sent marker).

### `schema_migrations`
`version INTEGER PK, applied_at TEXT`

## State transitions (per message)

```text
NEW → (rules) → SKIPPED | SELF_SENT                         [record]
NEW → (rules/LLM) → IMPORTANT → ANALYZED ─┐
                             → ANALYSIS_FAILED (fallback) ─┤
                                                           ▼
                             REPORT_PENDING  [pending_reports + one PENDING delivery per enabled channel]
                                │  each channel independently: PENDING → DELIVERED | (retry) | GAVE_UP
                                ▼
                 all channels finished → [record FORWARDED | FALLBACK_FORWARDED | DELIVERY_FAILED (all gave up)]
                                         delete pending_report (same transaction)
```

A message in REPORT_PENDING counts as "in progress" for the `last_seen_uid` advance. The pipeline first drains pending reports on every poll, and only then fetches new mail.

## Configuration entity
See `contracts/config.schema.md`.
