# Implementation Plan: AI Email Assistant (Self-hosted)

**Branch**: `001-ai-email-assistant` | **Date**: 2026-10-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-ai-email-assistant/spec.md`

## Summary

A single-process Node.js/TypeScript service polls one or more mailboxes over IMAP (read-only) and
cleans each new message to plain text. Each message then passes through a deterministic rules
engine and, when needed, the **Gatekeeper** LLM (classification). IMPORTANT mail goes to the
**Analyst** LLM (summarize and translate). The **Courier** (code only) builds a channel-neutral
Report and delivers it to every enabled channel: **Email** (SMTP, sent to an address that is not
monitored and marked as self-sent) and/or **Telegram** (Bot API). Delivery is tracked per channel.
Processing state lives in SQLite, which gives exactly-once handling across restarts. LLM output is schema-validated (zod), and every failure
path fails open by forwarding the original mail.

## Technical Context

**Language/Version**: TypeScript (strict, ESM) on Node.js ≥ 22 LTS (developed on Node 24)

**Primary Dependencies**: `imapflow` (IMAP), `mailparser` (MIME), `html-to-text` (HTML→text),
`nodemailer` (email channel), native `fetch` (Telegram Bot API channel, no SDK), `ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google`
(LLM providers, structured output), `zod` (schemas), `better-sqlite3` (state), `pino` (logs),
`dotenv` (secrets in dev)

**Storage**: SQLite file (`data/mail-me.db`), WAL mode

**Testing**: Vitest. Fakes for IMAP/SMTP/LLM/clock. Optional integration tests against a local
GreenMail container (IMAP + SMTP)

**Target Platform**: Linux server / home lab / Docker (amd64 + arm64 for Raspberry Pi)

**Project Type**: Single-project long-running service (daemon) with a small CLI
(`start`, `check-config`, `run-once`)

**Performance Goals**: About 100 emails/hour per installation is enough. Summary is sent within
poll interval + 2 min (SC-001)

**Constraints**: Read-only on source mailboxes. No secrets in logs. Memory < 200 MB. Body truncated
to the configured limit (default 12,000 chars) before an LLM call. LLM concurrency ≤ 2 by default

**Scale/Scope**: 1 user, 1–10 mailboxes, 1 target language

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How the design complies | Status |
|---|---|---|
| I. Self-hosted & privacy-first | Single process, local SQLite, no telemetry. Only processing records and short excerpts are stored, with configurable retention (`storage.retention_days`). Telegram is opt-in, and the quickstart documents that it is not end-to-end encrypted (constitution v1.1.0) | ✅ |
| II. Deterministic first | `rules/` runs before the Gatekeeper. Courier has no LLM. Each role has its own model | ✅ |
| III. Never lose mail | IMAP opened read-only (`readOnly: true`, BODY.PEEK). Fail-open fallback forward. Record written only after every enabled channel is finished. Per-channel retries from the stored Report | ✅ |
| IV. Untrusted input | Email passed in delimited data blocks, system prompt states that content is data. zod validation. HTML escaping in templates | ✅ |
| V. Modular & testable | Ports: `MailSource`, `ReportChannel` (email, telegram), `HttpFetch`, `LlmClient`, `Store`, `Clock`. Contract tests for schemas and channel formatting | ✅ |
| VI. Type safety & config | `strict: true`, zod config schema, fail-fast startup with field paths | ✅ |
| VII. Simplicity & observability | No queue, broker or web UI. pino JSON logs with per-email decision + token usage, redaction of secret paths | ✅ |

No violations. Complexity Tracking is empty.

*Post-design re-check (after Phase 1)*: still compliant. The contracts keep content and
instructions separate, and the data model stores no full bodies.

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-email-assistant/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── config.schema.md
│   ├── gatekeeper.contract.md
│   ├── analyst.contract.md
│   ├── delivery.contract.md
│   └── ports.contract.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── index.ts                 # CLI entry: start | run-once | check-config | check-delivery | telegram-chat-id
├── config/
│   ├── schema.ts            # zod schema (contracts/config.schema.md)
│   └── load.ts              # read config.json + resolve secret refs from env
├── domain/
│   └── types.ts             # IncomingEmail, ClassificationResult, AnalysisResult, ...
├── fetcher/
│   ├── imap-source.ts       # MailSource impl (imapflow, read-only, UID-based)
│   └── clean.ts             # mailparser + html-to-text + truncation
├── rules/
│   └── engine.ts            # processed? → whitelist → drop keyword → needs LLM
├── agents/
│   ├── llm.ts               # LlmClient port + AI SDK adapter (provider factory)
│   ├── gatekeeper.ts        # prompt + zod schema + confidence threshold
│   ├── analyst.ts           # prompt + zod schema
│   └── prompts/             # versioned prompt text files
├── courier/
│   ├── report.ts            # build channel-neutral Report (summary | fallback)
│   ├── dispatcher.ts        # fan-out to enabled channels, per-channel retry/give-up
│   └── channels/
│       ├── email/
│       │   ├── render.ts    # HTML + text templates, escaping
│       │   └── smtp-channel.ts  # ReportChannel (nodemailer) + self-sent marker headers
│       └── telegram/
│           ├── render.ts    # Telegram HTML subset, escaping, 4000-char split
│           └── telegram-channel.ts  # ReportChannel (Bot API via fetch), 429 handling
├── store/
│   ├── sqlite-store.ts      # Store impl (better-sqlite3), migrations
│   └── migrations/
├── orchestrator/
│   ├── pipeline.ts          # per-email flow + fail-open handling
│   └── scheduler.ts         # polling loop per account, isolation, backoff
└── lib/
    ├── logger.ts            # pino + redaction
    └── retry.ts             # exponential backoff helper

tests/
├── unit/                    # rules, clean, render, schemas, gatekeeper threshold
├── contract/                # config + agent output schemas, fixtures
├── integration/             # pipeline with fakes; optional GreenMail docker
└── fixtures/emails/         # .eml samples: important, promo, phishing, injection, huge-html

config.example.json
.env.example
Dockerfile
docker-compose.yml
```

**Structure Decision**: A single project (Option 1) with one module per pipeline stage, matching
the sub-agent design in the blueprint. Ports and adapters at the IO edges satisfy Principle V.

## Pipeline (per email)

```text
poll(account):
  0. drain pending_reports for this account → dispatcher (only PENDING channels whose next_attempt_at ≤ now)
  1. for each UID > last_seen_uid:
  fetch (PEEK) → clean/truncate → rules.evaluate
    ├─ ALREADY_PROCESSED → skip
    ├─ SELF_SENT        → record(skipped, SELF_SENT)   # X-Mail-Me header with our install_id
    ├─ WHITELIST        → category=IMPORTANT (no Gatekeeper)
    ├─ DROP_KEYWORD     → category=PROMOTION → record(skipped)
    └─ NEEDS_LLM        → Gatekeeper (retry) ── fail → treat IMPORTANT
                           └─ conf < threshold & not IMPORTANT → IMPORTANT
  IMPORTANT → Analyst (retry) ── fail → Report(kind=FALLBACK)
            → Report(kind=SUMMARY) → savePendingReport(report, enabledChannels)
            → dispatcher: deliver on each PENDING channel in parallel
                 ok → DELIVERED | retryable → attempts++ | fatal or attempts≥max → GAVE_UP
            → all channels finished → completeReport (record + delete pending, one transaction)
  advance last_seen_uid only over a contiguous prefix of UIDs that are recorded or have a pending report
```

Startup: validate config, including the address check that delivery.email.to is not monitored (FR-021), then `verify()` each enabled channel. A failed verification is logged as an error but does not block startup, because the network may be down. `check-delivery` runs verify() and sends a test report.

## Complexity Tracking

None.
