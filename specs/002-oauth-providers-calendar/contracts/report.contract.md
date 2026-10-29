# Contract: Report Content and Rendering (002)

Extends [001 delivery.contract](../../001-ai-email-assistant/contracts/delivery.contract.md) and
[001 analyst.contract](../../001-ai-email-assistant/contracts/analyst.contract.md).

## Analyst styles (FR-111, FR-112)

| | brief (default) | detailed |
|---|---|---|
| Prompt | `analyst.brief.v1.md` (new) | `analyst.v1.md` (001, unchanged) |
| Output schema | `AnalysisSchema` (001, unchanged) | same |
| summary (TL;DR) | ≤ 2 sentences and ≤ 40 words; **clamped in code** | as 001 |
| key_points | ≤ 3, each ≤ 15 words; **clamped in code** (extra points dropped, long ones cut with `…`) | ≤ 10 |
| action_items | only when present | as 001 |
| excerpt | ≤ min(`excerpt_chars`, 300) chars | `excerpt_chars` (default 600) |

Clamping happens in `buildReport` (`src/courier/report.ts`), so a model that ignores the limits
still produces a compliant report (SC-105). Word counting splits on whitespace; for languages
written without spaces it falls back to a character limit (120 chars per point, 240 for the TL;DR).

## Report layout, brief style (both channels, same order)

```text
🔴 [AI Summary] <subject>                         ← 🔴 only when urgent
📥 <account label> · ✉️ <sender>
👥 To: Alice, you, Bob and 4 more · Cc: Carol      ← "you" marks the monitored address
   or: 👥 To: course-list@uni.edu · received at you@uni.edu
   or: 👥 undisclosed recipients · received at you@uni.edu

<TL;DR>
• <point 1>
• <point 2>
• <point 3>
Action needed: No                                  ← or "✅ Actions:" list with deadlines

📅 <event title> — Thu 6 Nov, 14:00–14:45 (Asia/Ho_Chi_Minh)
   Teams: https://teams.microsoft.com/…  ·  📍 Room 204
   Add to Google Calendar · Add to Outlook calendar
📅 <event 2> — time not set
📅 <event 3> — Cancelled
(+2 more events in the email)

<excerpt, quoted>
Open original                                      ← only when webLink is set
```

- Recipient display: name if present, else address; each list ≤ 5 then `and N more` (FR-128).
- Event times shown in the config `timezone`; if the event's zone differs, the original is added:
  `14:00 (09:00 Europe/London)`.
- Detailed style keeps the 001 layout and adds the same recipients line, Event section and link.
- Both styles show "Action needed: No" when there are no action items (FR-112).
- `schedulerFailed` → one line `⚠ Event detection failed, check the email for dates` where the
  Event section would be.
- FALLBACK reports (Analyst failed) still show recipients, events and the link.

## Escaping (FR-120, FR-128, constitution IV)

| Value | Email HTML | Email text | Telegram HTML |
|---|---|---|---|
| names, addresses, event fields, AI text | HTML-escaped | as is | `& < >` escaped |
| calendar URLs, webLink, meeting URL | `href` from code-built/validated URL, attribute-escaped | printed URL | `<a href>` with `"` escaped |

Calendar and "Open original" anchors are created only by code from validated URLs (`https:` and
the hosts in research R7/R11). Text from the email or the AI never becomes a link target except the
meeting URL, which must be `https:` and is shown as written.

## Telegram length (US3-3)

Order of shortening when over the limit (extends 001 research R14): excerpt first (down to the
001 minimum), then the "Open original" line is kept and event detail lines (location) are dropped,
then the message is split. With brief style a typical report fits in one message (SC-105).

## Email channel extras

- `event.ics` attachment when any event has links (scheduler.contract).
- Subject unchanged from 001.
