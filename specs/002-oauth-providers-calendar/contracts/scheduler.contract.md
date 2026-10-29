# Contract: Scheduler Agent, Invitations and Calendar Links (002)

## When it runs

IMPORTANT emails only (Gatekeeper IMPORTANT or whitelist), after the Analyst (FR-113). Invitation
parsing needs no AI and always runs; `ai.scheduler.enabled: false` only stops the AI call. Order per
email:

1. Message has a `text/calendar` part or `.ics` attachment → parse with ical.js → events, **no AI call** (FR-114).
2. Else, Scheduler enabled → one LLM call (role `scheduler`, temperature 0, retry per 001).
3. Else → no events.

Any error in 1 or 2 → `events: []`, `schedulerFailed: true`, log `scheduler failed`; the report is
delivered normally with a one-line "⚠ Event detection failed, check the email for dates" notice
(FR-119, SC-109, constitution III).

## LLM input (prompt `src/agents/prompts/scheduler.v1.md`)

System prompt: what counts as an event; output local times only, never compute offsets; use
`<sent_at>` to resolve relative dates and missing years; leave `timezone` null unless the email
states one; `time_known: false` when no usable date+time; at most 5 events; same untrusted-data
rules as 001 (research R5).

User message:

```text
<email>…same block as Analyst (001)…</email>
<sent_at>2026-11-03T09:12:00+07:00</sent_at>
<user_timezone>Asia/Ho_Chi_Minh</user_timezone>
```

## LLM output schema (zod, strict)

```ts
const SchedulerSchema = z.object({
  events: z.array(z.object({
    title: z.string().min(1).max(120),
    status: z.enum(["new", "rescheduled", "cancelled"]),
    time_known: z.boolean(),
    all_day: z.boolean(),
    start_local: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).nullable(),
    end_local: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).nullable(),
    duration_minutes: z.number().int().min(1).max(60 * 24 * 14).nullable(),
    timezone: z.string().max(64).nullable(),        // IANA, validated in code
    location: z.string().max(200).nullable(),
    meeting_url: z.string().max(500).nullable(),
  })).max(5),
});
```

## Normalization (plain code)

| Rule | Result |
|---|---|
| `time_known` false or `start_local` null | `timeSet: false`, no links |
| `timezone` null or not a valid IANA zone | config `timezone` |
| `end_local` null | `start + duration_minutes`, else `start + 60 min`; all-day → next day |
| `end <= start` | treat as `end_local: null` |
| `meeting_url` not `https:` | dropped (shown nowhere) |
| `status: cancelled` | no links |
| `end <= now` | no links (US4-9) |
| more than 3 events | keep first 3, `eventsOmitted = n - 3` |

ical.js mapping: `SUMMARY`→title, `DTSTART`/`DTEND`/`DURATION` (with `VTIMEZONE`), `LOCATION`,
first `https:` URL in `X-MICROSOFT-SKYPETEAMSMEETINGURL` / `X-GOOGLE-CONFERENCE` / `URL` /
`DESCRIPTION` → meetingUrl; `METHOD:CANCEL` or `STATUS:CANCELLED` → cancelled; `METHOD:REQUEST`
with `SEQUENCE > 0` → rescheduled.

## Links and file (`src/calendar/links.ts`, `src/calendar/ics.ts`, pure functions)

```ts
googleCalendarUrl(e: DetectedEvent, details: string): string
outlookCalendarUrl(e: DetectedEvent, details: string, host: "outlook.live.com" | "outlook.office.com"): string
icsFile(events: DetectedEvent[], key: MessageKey, now: Date): string   // METHOD:PUBLISH
```

- `details` = meeting URL + `"From: <sender> — <subject>"`, capped at 500 chars.
- All values encoded with `URLSearchParams`; iCal text escaped (`\\ ; , \n`) and folded at 75 octets.
- Email channel attaches `event.ics` (`text/calendar; method=PUBLISH; charset=utf-8`) when at least
  one event has links.
- The assistant never calls any calendar API and requests no calendar scope (FR-118).

## Contract tests

- Schema: valid/invalid fixtures; injected text in the email does not change output shape.
- Normalization: relative date from `sent_at`, explicit zone kept, DST boundary, all-day, multi-day,
  past event, cancelled, >3 events.
- Invitation fixtures: Google invite, Outlook invite with Windows zone `VTIMEZONE`, cancellation.
- Links: snapshot of Google/Outlook URLs and `.ics` text for fixed events; special characters
  (`&`, `#`, newline, `<script>`) are encoded.
