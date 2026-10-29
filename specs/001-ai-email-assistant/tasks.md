---

description: "Task list for AI Email Assistant (Self-hosted)"
---

# Tasks: AI Email Assistant (Self-hosted)

**Input**: Design documents from `/specs/001-ai-email-assistant/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. Constitution Principle V requires automated tests and contract tests for agent and config schemas.

**Organization**: Tasks are grouped by user story so each one can be implemented and tested on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4 from spec.md
- Paths: single project, `src/` and `tests/` at repo root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [X] T001 Create directory layout from plan.md (`src/{config,domain,fetcher,rules,agents/prompts,courier,store/migrations,orchestrator,lib}`, `tests/{unit,contract,integration,fakes,fixtures/emails}`)
- [X] T002 Initialize `package.json` (type: module, engines node ≥22, scripts: build, start, run-once, check-config, test, lint, typecheck) and install pinned deps from research.md
- [X] T003 [P] Add `tsconfig.json` (strict, NodeNext, outDir `dist`) and a `tsx` dev runner
- [X] T004 [P] Configure ESLint + Prettier (`eslint.config.js`, `.prettierrc`)
- [X] T005 [P] Configure Vitest (`vitest.config.ts`) with `tests/` globs and coverage
- [X] T006 [P] Update `.gitignore` (`data/`, `.env`, `config.json`, `dist/`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

- [X] T007 Define domain types (IncomingEmail, RuleDecision, ClassificationResult, AnalysisResult, ProcessedRecord, MailboxState) in `src/domain/types.ts`
- [X] T008 Define ports (MailSource, ReportChannel, HttpFetch, LlmClient, Store, Clock) and the Report type in `src/domain/ports.ts` per contracts/ports.contract.md
- [X] T009 [P] Implement the zod config schema (incl. `delivery` block, at least one channel enabled) in `src/config/schema.ts` per contracts/config.schema.md
- [X] T010 Implement the config loader (read file, apply defaults, resolve `*_env` secrets, error messages with field paths) in `src/config/load.ts`
- [X] T011 [P] Contract tests for the config schema (valid, missing fields, unset env, unknown keys) in `tests/contract/config.test.ts`
- [X] T012 [P] Logger with secret redaction in `src/lib/logger.ts`, plus a unit test confirming no secrets in output in `tests/unit/logger.test.ts`
- [X] T013 [P] Retry/backoff helper and semaphore in `src/lib/retry.ts` + `tests/unit/retry.test.ts`
- [X] T014 SQLite store: migrations (`mailbox_state`, `processed_messages`, `pending_reports`, `deliveries`, `meta` with install_id, `schema_migrations`) and Store impl in `src/store/sqlite-store.ts`, `src/store/migrations/001_init.sql`
- [X] T015 [P] Store unit tests (idempotent record, isProcessed by UID and by Message-ID, pending report lifecycle, completeReport atomicity, purge) in `tests/unit/store.test.ts`
- [X] T016 [P] Test fakes: FakeMailSource, FakeChannel (scriptable failures, records deliveries), FakeHttpFetch, FakeLlm (scripted), FakeClock in `tests/fakes/`
- [X] T017 [P] Email fixtures (`important-deadline.eml`, `promo.eml`, `phishing.eml`, `injection.eml`, `huge-html.eml`, `no-body-attachment.eml`, `vietnamese.eml`) in `tests/fixtures/emails/`

**Checkpoint**: Config, store, logging and test fakes are ready.

---

## Phase 3: User Story 1 - Important email arrives as a summary (Priority: P1) 🎯 MVP

**Goal**: One mailbox → Gatekeeper → Analyst → Courier → summary in the primary inbox, exactly once.

**Independent Test**: The integration test with fakes delivers one formatted summary for `important-deadline.eml`, and restarting the pipeline sends nothing more. The manual check follows quickstart steps 5.1, 5.2 and 5.4.

### Tests for User Story 1

- [X] T018 [P] [US1] Unit tests for cleaning (HTML→text, reply-chain strip, truncation flag, attachments list) in `tests/unit/clean.test.ts`
- [X] T019 [P] [US1] Contract tests for the Gatekeeper output schema (valid and malformed fixtures) in `tests/contract/gatekeeper.test.ts`
- [X] T020 [P] [US1] Contract tests for the Analyst output schema in `tests/contract/analyst.test.ts`
- [X] T021 [P] [US1] Email render tests (snapshot HTML + text, escaping of `<script>` in subject or summary, urgent prefix, truncated note, marker headers present) in `tests/unit/email-render.test.ts`
- [X] T022 [US1] Pipeline integration test: important → FORWARDED, restart → no duplicate, Analyst failure → FALLBACK_FORWARDED, SMTP failure → not recorded and retried on next poll, first run processes only mail inside the look-back window (FR-019), UIDVALIDITY change → re-baseline with no reprocessing, in `tests/integration/pipeline.test.ts`

### Implementation for User Story 1

- [X] T023 [P] [US1] Email cleaning (mailparser + html-to-text + truncation) in `src/fetcher/clean.ts`
- [X] T024 [P] [US1] IMAP MailSource (imapflow, `readOnly: true`, UID fetch with PEEK, UIDVALIDITY handling, first-run baseline/look-back) in `src/fetcher/imap-source.ts`
- [X] T025 [P] [US1] LlmClient adapter (AI SDK provider factory for openai/anthropic/google, structured output + zod re-validation, usage) in `src/agents/llm.ts`. First confirm the current v7 structured-output API (research R4)
- [X] T026 [P] [US1] Gatekeeper prompt `src/agents/prompts/gatekeeper.v1.md` + `src/agents/gatekeeper.ts` (`<email>` data wrapping, temp 0, failure → IMPORTANT)
- [X] T027 [P] [US1] Analyst prompt `src/agents/prompts/analyst.v1.md` + `src/agents/analyst.ts` (target language, no-translate-if-same, null deadlines)
- [X] T028 [P] [US1] Report builder `src/courier/report.ts` + email renderer (summary + fallback templates, inline CSS, escapeHtml, text alternative) in `src/courier/channels/email/render.ts`
- [X] T029 [P] [US1] Email ReportChannel (nodemailer, TLS, Reply-To, In-Reply-To/References, `X-Mail-Me` self-sent marker + `Auto-Submitted`, X-Mail-Me-Source, verify()) in `src/courier/channels/email/smtp-channel.ts`
- [X] T030 [US1] Pipeline orchestration (per-email flow, build Report → savePendingReport → deliver via email channel → completeReport, advance `last_seen_uid` over the contiguous prefix of recorded UIDs) in `src/orchestrator/pipeline.ts`
- [X] T031 [US1] Polling scheduler (setTimeout loop, no overlap) and CLI `start` / `run-once` in `src/orchestrator/scheduler.ts`, `src/index.ts`
- [X] T032 [US1] Per-email decision logging (category, confidence, outcome, tokens, latency, no body) in `src/orchestrator/pipeline.ts`

**Checkpoint**: MVP works end to end for one mailbox through the email channel. Until US3's loop protection lands, use a report address that is **not** monitored.

---

## Phase 4: User Story 2 - Spam and promotions filtered out (Priority: P2)

**Goal**: Deterministic rules before the LLM, a confidence threshold, and resistance to injection.

**Independent Test**: Pipeline test with promo, phishing and important fixtures. Only the important one is forwarded. Rule hits make 0 LLM calls (checked through the FakeLlm call count).

### Tests for User Story 2

- [X] T033 [P] [US2] Rules engine unit tests (whitelist with subdomains and leading `@`, drop keyword in subject or sender only, never in body, case-insensitive whole-word, precedence) in `tests/unit/rules.test.ts`
- [X] T034 [P] [US2] Threshold tests (PROMOTION 0.5 → IMPORTANT, SPAM 0.9 → SPAM) in `tests/unit/gatekeeper-threshold.test.ts`
- [X] T035 [P] [US2] Integration: promo/phishing → SKIPPED and logged, whitelist → IMPORTANT with no Gatekeeper call, injection fixture → routing unchanged, in `tests/integration/filtering.test.ts`

### Implementation for User Story 2

- [X] T036 [US2] Rules engine in `src/rules/engine.ts`
- [X] T037 [US2] Apply `confidence_threshold` in `src/agents/gatekeeper.ts` _(done with US1: threshold applied in `classify()`)_
- [X] T038 [US2] Wire rules into the pipeline before the Gatekeeper and record SKIPPED outcomes in `src/orchestrator/pipeline.ts`

**Checkpoint**: Noise filtering works and rule hits cost nothing.

---

## Phase 5: User Story 3 - Multiple mailboxes, reported by email and/or Telegram (Priority: P3)

**Goal**: Several accounts polled independently. Reports are delivered to any combination of Email (to an address that is not monitored, with loop protection) and Telegram, and each channel is tracked and retried on its own.

**Independent Test**: Two FakeMailSources each deliver an important mail with both channels enabled → each channel gets two labeled reports. Telegram fails once → email is not duplicated, Telegram succeeds on the next poll, and the LLM is called only once per email. A config with the report address equal to a monitored address → startup refused. An incoming message carrying our `X-Mail-Me` marker → SELF_SENT, with no LLM call.

### Tests for User Story 3

- [X] T039 [P] [US3] Integration test for multiple accounts and failure isolation in `tests/integration/multi-account.test.ts`
- [X] T054 [P] [US3] Config tests for loop prevention: `delivery.email.to` equal to a monitored address, differing only by case, `+tag` or Gmail dots → rejected with message. No channel enabled → rejected. In `tests/contract/config-delivery.test.ts`
- [X] T055 [P] [US3] Rules test: message with `X-Mail-Me` + our install_id → SELF_SENT before every other rule. A foreign `X-Mail-Me` id or `Auto-Submitted` alone → not self-sent. In `tests/unit/rules-self-sent.test.ts`
- [X] T056 [P] [US3] Telegram render tests (HTML escaping, only allowed tags, ≤ 4000 chars per part, excerpt shortened before split, split keeps tags balanced, `(i/N)` labels, fallback format) in `tests/unit/telegram-render.test.ts`
- [X] T057 [P] [US3] Telegram channel tests with FakeHttpFetch (sendMessage payload, link previews disabled, 429 → retryAfterMs, 400/401/403 → non-retryable, token never in error or log, verify() via getMe + getChat) in `tests/contract/telegram-channel.test.ts`
- [X] T058 [US3] Dispatcher integration test (both channels; one fails retryably → retried only that channel, no AI re-call, no duplicate; restart in the middle of delivery → resumes from pending_reports; max_attempts → GAVE_UP and message completed; all channels gave up → DELIVERY_FAILED) in `tests/integration/delivery.test.ts`

### Implementation for User Story 3

- [X] T040 [US3] One scheduler loop per account/mailbox with per-account error isolation and backoff in `src/orchestrator/scheduler.ts`
- [X] T041 [US3] Bounded LLM concurrency shared across accounts (semaphore from T013) in `src/agents/llm.ts` _(done with US1: one shared semaphore in `AiSdkLlmClient`)_
- [X] T042 [US3] Source account label in both renderers (email header line + `X-Mail-Me-Source`, Telegram 📥 line) in `src/courier/channels/*/render.ts`
- [X] T059 [US3] Address normalization + "report address is not monitored" refinement in `src/config/schema.ts` (helper in `src/config/address.ts`)
- [X] T060 [US3] SELF_SENT rule (first rule after ALREADY_PROCESSED, compares install_id from Store) in `src/rules/engine.ts`. Expose headers in `src/fetcher/imap-source.ts` _(pulled into US1 so the MVP cannot loop on its own reports)_
- [X] T061 [P] [US3] Telegram renderer (HTML subset, escaping, shorten/split) in `src/courier/channels/telegram/render.ts`
- [X] T062 [P] [US3] Telegram ReportChannel (Bot API via fetch, per-chat 1 msg/s throttle, parts_sent resume, error classification, token redaction, verify()) in `src/courier/channels/telegram/telegram-channel.ts`
- [X] T063 [US3] Dispatcher (fan-out to enabled channels in parallel, per-channel status/attempts/next_attempt_at, give up at max_attempts, completeReport) in `src/courier/dispatcher.ts`, and drain pending reports at the start of each poll in `src/orchestrator/pipeline.ts`
- [X] T064 [US3] Channel factory from config + startup `verify()` (logged, non-blocking) in `src/courier/channels/index.ts`
- [X] T065 [P] [US3] CLI `check-delivery` (verify + send test report to each enabled channel) and `telegram-chat-id` (getUpdates → print chat IDs) in `src/index.ts`

**Checkpoint**: Multi-mailbox flow works, with email and/or Telegram delivery and no feedback loops.

---

## Phase 6: User Story 4 - Self-host setup with one config file (Priority: P3)

**Goal**: A non-developer can configure and start the assistant within 15 minutes.

**Independent Test**: `check-config` passes on an edited example and fails with field-named messages on invalid variants. Separate models per role are verified with FakeLlm.

- [X] T043 [P] [US4] `config.example.json` (no secrets, plain JSON, email enabled + telegram disabled) and `.env.example` (incl. `TELEGRAM_BOT_TOKEN`) at repo root
- [X] T044 [P] [US4] `check-config` CLI command (exit 0 / exit 2 with message) in `src/index.ts` _(done with US1)_
- [X] T045 [P] [US4] Test that the gatekeeper and analyst roles use their own configured provider and model, in `tests/integration/roles.test.ts`
- [X] T046 [US4] `Dockerfile` (multi-stage, non-root, `/app/data` volume) and `docker-compose.yml`
- [X] T047 [US4] README: overview, architecture diagram, quickstart (from quickstart.md), privacy notes (incl. Telegram not end-to-end encrypted), Gmail app-password guide, Telegram bot setup

**Checkpoint**: Ready for self-hosting.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T048 [P] Daily retention purge job (`storage.retention_days`) in `src/orchestrator/scheduler.ts`
- [X] T049 [P] Optional GreenMail E2E (`E2E=1`) in `tests/e2e/greenmail.test.ts` with a docker-compose test profile. Asserts that source messages stay unseen, unmoved and unflagged (FR-013)
- [X] T050 [P] Gatekeeper evaluation script on a labeled `.eml` set (measures SC-003) in `scripts/eval-gatekeeper.ts`
- [X] T051 [P] GitHub Actions CI: typecheck, lint, test in `.github/workflows/ci.yml`
- [X] T052 Graceful shutdown (SIGTERM: finish the in-flight email, close IMAP and DB) in `src/index.ts` _(done with US1: SIGINT/SIGTERM waits for the current pass, then closes the DB)_
- [X] T053 Run the quickstart.md validation manually against a real mailbox

---

## Dependencies & Execution Order

- Setup (P1) → Foundational (P2) → **US1 (MVP)** → US2 → US3 / US4 (these two can run in parallel) → Polish
- US2 changes `pipeline.ts` and `gatekeeper.ts` from US1. US3 changes `scheduler.ts`, `pipeline.ts`, `rules/engine.ts` (after US2's T036) and `config/schema.ts` from earlier phases.
- Within US3: T059 → T054 green. T060 → T055. T061 → T062 → T057. T063 depends on T062 + T029. T064/T065 depend on T063.
- US4's T043–T045 only depend on Foundational and can start alongside US1.
- Within a story: tests → implementation. T030 depends on T023–T029. T031 depends on T030.

## Parallel Example: User Story 1

```text
# After Foundational, launch together:
T018 clean tests, T019 gatekeeper contract, T020 analyst contract, T021 render tests
T023 clean.ts, T024 imap-source.ts, T025 llm.ts, T026 gatekeeper.ts, T027 analyst.ts, T028 report.ts + email/render.ts, T029 smtp-channel.ts
# Then sequentially: T030 pipeline → T031 scheduler/CLI → T032 logging → T022 integration test green
```

## Implementation Strategy

1. **MVP**: Phases 1–3. Stop and run quickstart steps 5.1, 5.2 and 5.4 on one real mailbox.
2. **Increment 2**: US2 filtering. Measure SC-003 with T050.
3. **Increment 3**: US3 and US4, then Docker plus README for a public release.
4. Commit after each task or logical group (Conventional Commits).
