# Contract: Report Delivery Channels

## Report (channel-neutral input)
```ts
type Report = {
  key: { accountId: string; mailbox: string; uidValidity: number; uid: number };
  source: { accountId: string; label: string };
  original: { messageId: string | null; from: { name?: string; address: string }; subject: string; receivedAt: string };
  kind: "SUMMARY" | "FALLBACK";          // FALLBACK = AI analysis failed
  analysis: AnalysisResult | null;         // null when kind = FALLBACK
  excerpt: string;                          // first limits.excerpt_chars of the cleaned text
  truncated: boolean;
  urgent: boolean;                          // analysis.requires_immediate_attention
  actionNeeded: boolean;                    // analysis.action_items.length > 0
};
```
A Report is built once, after analysis, and stored (`pending_reports`) until every enabled channel is finished. Retries reuse it and never call the AI again (FR-024).

## Channel port
```ts
interface ReportChannel {
  readonly name: "email" | "telegram";
  /** Delivers one report. Throws ChannelError { retryable: boolean; retryAfterMs?: number }. */
  deliver(report: Report): Promise<{ externalId: string }>;
  /** Startup/`check-delivery` probe: verify credentials and destination without delivering a report. */
  verify(): Promise<void>;
}
```

---

## Email channel
- Transport: SMTP (nodemailer), TLS.
- To: `delivery.email.to`, which config validation guarantees is not monitored (FR-021).
- Subject: `[AI Summary] {subject}`. Prefix `🔴 ` when urgent. Fallback: `[Not summarized] {subject}`.
- Body: Source account · From · TL;DR · Key points `<ul>` · Action items (with deadline) · "Action needed: Yes/No" · "(content truncated)" note · `--- Original excerpt ---`. HTML with inline CSS plus a text/plain alternative. Every interpolated value is HTML-escaped.
- **Self-sent marker headers (FR-022)** on every report:
  - `X-Mail-Me: report; v=1; id=<install_id>`, where `install_id` is a random UUID generated on first run and stored in the DB
  - `Auto-Submitted: auto-generated` (RFC 3834)
  - `X-Mail-Me-Source: <account label>`
  - `Reply-To: <original sender>`, `In-Reply-To`/`References: <original Message-ID>` when present
- verify(): `transporter.verify()`.
- Errors: connection or 4xx → retryable. 5xx auth or recipient-rejected → not retryable (counts toward max_attempts and is logged as an error).

## Telegram channel
- Transport: Bot API over HTTPS using native `fetch`, with no SDK dependency.
  `POST https://api.telegram.org/bot<token>/sendMessage`
  `{ chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }`
- The bot token is never logged. The URL is redacted in logs and errors.
- Format (Telegram HTML subset only: `<b> <i> <u> <s> <a> <code> <pre> <blockquote>`). Escape `& < >` in every interpolated value:
  ```text
  🔴 <b>[AI Summary] {subject}</b>          (🔴 only if urgent)
  📥 {source label} · ✉️ {sender}
  <b>TL;DR:</b> {summary}
  <b>Key points</b>
  • {point}
  <b>Action items</b>
  ☐ {action} — <i>{deadline}</i>
  <b>Action needed:</b> Yes/No
  <blockquote expandable>{excerpt}</blockquote>
  ```
  Fallback reports say `⚠️ <b>AI summary unavailable</b>` and show the excerpt.
- **Size (FR-023)**: Telegram allows 4096 chars after entity parsing, and we budget 4000. Step 1: shorten the excerpt, keeping a "…" marker. Step 2, if it is still too long: split at line boundaries into parts labeled `(1/N)` and never split inside a tag. `externalId` = the first part's `message_id`. A part that fails is retried by re-sending every part from that one on (stored as `parts_sent` in the delivery row).
- verify(): `getMe` (token valid) + `getChat(chat_id)` (bot can reach the chat). An error tells the user to send `/start` to the bot first.
- Errors: HTTP 429 → retryable with `retryAfterMs = parameters.retry_after * 1000`. 5xx/network → retryable. 400 "chat not found" / 401 / 403 "bot was blocked" → not retryable.

## Delivery orchestration
```text
enabled = channels with enabled: true
for ch in enabled where delivery[key, ch].status == PENDING:
    try deliver → status DELIVERED, external_id
    catch retryable → attempts++, last_error (retry on the next poll; honor retryAfterMs)
    catch non-retryable or attempts ≥ max_attempts → status GAVE_UP, log error
if every enabled channel is DELIVERED or GAVE_UP:
    record processed (outcome FORWARDED | FALLBACK_FORWARDED | DELIVERY_FAILED if all GAVE_UP)
    delete pending_report
```
Channels run in parallel for each report. A channel that fails never blocks or duplicates another channel.

## Contract tests
- Email: escaping, marker headers present, urgent and fallback subjects.
- Telegram: HTML escaping (`<script>`, `&`), no tags other than the allowed set, length ≤ 4000 per part, splitting keeps tags balanced, 429 handling uses `retry_after`, token never appears in a thrown error message.
