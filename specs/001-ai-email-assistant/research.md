# Research: AI Email Assistant

Package versions were checked on npm on 2026-10-29: imapflow 2.9.1, mailparser 3.12.4,
html-to-text 10.0.1, nodemailer 10.3.0, ai 7.0.x, @ai-sdk/* 4.0.x, zod 4.6.x,
better-sqlite3 13.0.x, pino 10.4.x, vitest 5.0.x, typescript 7.0.x. Pin exact versions in the lockfile.

## R1. IMAP client
- **Decision**: `imapflow`. Open the mailbox with `readOnly: true`, fetch by UID with `source` and use BODY.PEEK so the `\Seen` flag is never set.
- **Rationale**: Promise-based, maintained, TypeScript types, IDLE support for later.
- **Alternatives**: `node-imap` (unmaintained, callback API); Gmail API (provider lock-in, needs OAuth).

## R2. Exactly-once tracking
- **Decision**: For each account and mailbox, store `uid_validity` and `last_seen_uid`, plus a `processed_messages` row keyed by `(account_id, uid_validity, uid)`. Keep `message_id` as a secondary dedup across UIDVALIDITY resets.
- **Rationale**: UIDs are monotonic within one UIDVALIDITY. If UIDVALIDITY changes, re-baseline to the current max UID and dedup with Message-ID. The history is never reprocessed (spec edge case).
- **First run**: set `last_seen_uid = current UIDNEXT-1` (look-back 0) or search `SINCE now-lookback` (FR-019).

## R3. HTML → text
- **Decision**: `mailparser.simpleParser` → prefer `text`, otherwise `html-to-text` (`wordwrap:false`, skip images, links rendered as `text [url]`). Collapse whitespace, strip quoted reply chains (`>` lines, "On … wrote:"), and truncate to `limits.max_body_chars`, setting `truncated=true`.
- **Rationale**: Saves tokens. Removing reply chains cuts a lot of noise.

## R4. LLM abstraction and structured output
- **Decision**: Vercel AI SDK (`ai` v7) with provider packages for OpenAI, Anthropic and Google. Use structured output with a zod schema: the SDK's object-output API, either `generateText` with `Output.object` or `generateObject`. **Confirmed (2026-10-29, ai 7.0.156): `generateText({ instructions, prompt, output: Output.object({ schema }) })` → `result.output`. `generateObject` and `system` are deprecated.** Always re-validate the result with zod ourselves.
- **Rationale**: One interface for every provider (FR-015), native schema support, and it reports token usage for logs.
- **Alternatives**: LangChain.js (heavier, more abstraction than needed). Raw provider SDKs (three separate code paths).
- **Model defaults** (config example only; users choose their own): Gatekeeper uses a small or fast model, Analyst uses a stronger model. Model IDs are always read from config and never hardcoded.

## R5. Prompt-injection hardening
- **Decision**: The system prompt states that the content between `<email>` tags is untrusted data and never instructions. Email fields go in the user message, wrapped in tags, and any literal `</email>` is escaped. Temperature is 0 for the Gatekeeper. Output is validated by schema, and routing rules are applied in code, never by the LLM.
- **Rationale**: Schema plus code-side routing means injected text can at most affect the category for that single email. With fail-open, the worst outcome is an extra summary.

## R6. Fail-open and retries
- **Decision**: `retry(fn, {attempts:3, base:1s, factor:2, jitter})` around LLM and SMTP calls. Gatekeeper failure → treat as IMPORTANT. Analyst failure → fallback email containing the cleaned excerpt and a "⚠ not summarized" banner. SMTP failure → no record is written, so the message is retried next poll. Bounded concurrency is handled by a small semaphore (`limits.llm_concurrency`, default 2).

## R7. Storage
- **Decision**: `better-sqlite3` (synchronous, fast, simple transactions), WAL, and SQL migrations run at startup.
- **Alternatives**: built-in `node:sqlite` (moving toward stable and removes a native build; reconsider once stable across LTS releases); JSON file (no atomicity).

## R8. Config and secrets
- **Decision**: `config.json` validated by zod. Secret fields hold an env var name (`"password_env": "SCHOOL_IMAP_PASSWORD"`) and are resolved at startup. A missing env var → fail with the field path. In dev, `.env` is loaded by dotenv. `check-config` CLI validates and exits.
- **Note**: The blueprint's sample config uses `//` comments, which are not valid JSON. The example ships either as plain JSON, or as JSONC parsed with comment stripping. **Decision: plain JSON, with documentation in quickstart.**

## R9. Drop keywords
- **Decision**: Case-insensitive whole-word match on the subject and sender display name or address only (clarification). The default example list leaves out "unsubscribe".

## R10. Courier rendering
- **Decision**: A small template literal with an `escapeHtml` helper. Inline CSS (email clients strip `<style>`). A `text` alternative is always produced. Headers: `Subject: [AI Summary] …`, `Reply-To: original sender`, plus `X-Mail-Me-Source: <account label>`, `References/In-Reply-To` original Message-ID (helps threading).
- **Alternatives**: MJML or React Email (more dependencies than v1 needs).

*R10 update (2026-10-29)*: the Courier now builds a channel-neutral Report, and the email template
above becomes the email channel's renderer. See R13–R15.

## R11. Scheduling
- **Decision**: An internal `setTimeout` loop per account (`poll_interval_seconds`, default 300) instead of a cron library. It never overlaps runs and isolates errors per account. `run-once` mode lets an external cron or systemd timer drive it.
- **Rationale**: Simpler than node-cron and covers both use cases.

## R12. Testing strategy
- Unit: rules, clean, render (snapshot), threshold logic, config validation.
- Contract: zod schemas against fixture JSON, including malformed LLM outputs.
- Integration: pipeline with `FakeMailSource`, `FakeSender`, `FakeLlm` (scripted responses), and `:memory:` SQLite: restart and dedup, fail-open, injection fixture.
- Optional E2E: GreenMail docker (IMAP/SMTP) with a fake LLM, gated by `E2E=1`.
- Evaluation script (not CI): run the Gatekeeper on a labeled `.eml` set to measure SC-003.

## R13. Delivery channel choice
- **Decision**: Email + Telegram in v1.
- **WhatsApp rejected**: the official Meta Cloud API / Twilio need Business verification, and messages started by the business outside the 24h window must use pre-approved templates, which is a bad fit for free-form summaries. Unofficial WhatsApp Web clients (Baileys, whatsapp-web.js) break WhatsApp's terms and risk banning the user's number. Revisit as a plugin channel later.
- **Extensibility**: the `ReportChannel` port means a new channel is one folder under `courier/channels/` plus a config block.

## R14. Telegram implementation
- **Decision**: call the Bot API directly with native `fetch` (`sendMessage`, `getMe`, `getChat`, `getUpdates`). No SDK (grammY or telegraf would be overkill for send-only).
- `parse_mode: "HTML"`, because HTML escaping (`& < >`) is much less error-prone than MarkdownV2's 18 reserved characters. Use only the supported tags. `<blockquote expandable>` collapses the excerpt.
- 4096-char limit: budget 4000, shorten the excerpt first, then split at line boundaries into `(i/N)` parts.
- 429 → honor `parameters.retry_after`. Bots are limited to about 1 msg/s per chat, so a shared per-chat throttle runs at 1 msg/s.
- Setup helper: `telegram-chat-id` CLI calls `getUpdates` after the user sends `/start` to the bot, and prints the chat IDs it finds, so users don't need curl.
- The token is part of the URL path, so it MUST be redacted from logged URLs and from error messages (logger redaction + ChannelError sanitization).
- Privacy: bot chats are stored on Telegram's servers and are not end-to-end encrypted. Documented in the quickstart (constitution I).

## R15. Feedback-loop prevention for the email channel
- **Layer 1 (static)**: config validation rejects `delivery.email.to` if it matches a monitored address after normalization (lowercase, strip `+tag`, Gmail dot-insensitivity).
- **Layer 2 (runtime)**: each report carries `X-Mail-Me: report; v=1; id=<install_id>` and `Auto-Submitted: auto-generated`. The rules engine checks for `X-Mail-Me` with our install_id *before* any other rule → `SELF_SENT`, recorded, never classified or reported. This catches aliases, auto-forward rules and shared inboxes that layer 1 cannot see.
- `Auto-Submitted` alone is not used to skip, because legitimate automated mail (bills, school portals) also sets it. Only our own marker counts.
- Rejected: skipping by sender address. The SMTP sender may legitimately be the same account the user sends real mail from.

## R16. Multi-channel delivery state
- **Decision**: build the Report once, persist it in `pending_reports` along with a `deliveries` row per channel, and retry only the PENDING channels on later polls. Give up after `delivery.max_attempts`.
- **Rationale**: no AI re-calls and no duplicates on channels that already delivered (FR-024). A dead Telegram bot cannot block email delivery forever.
- Rejected: an in-memory retry queue (lost on restart, which breaks exactly-once).
