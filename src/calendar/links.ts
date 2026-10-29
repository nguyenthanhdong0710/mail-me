import { DateTime } from "luxon";
import type { DetectedEvent } from "../domain/types.js";

// "Add to calendar" links built by plain code (FR-117, research R11). The user opens them in
// their own browser session; the assistant never calls a calendar API (FR-118).

/** Details text is capped so links stay under URL length limits. */
export const MAX_DETAILS = 500;

export type OutlookHost = "outlook.live.com" | "outlook.office.com";

type TimedEvent = DetectedEvent & { start: string; end: string };

const compact = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
const dateOnly = (iso: string) => iso.replace(/-/g, "");

export function eventDetails(e: DetectedEvent, from: string, subject: string): string {
  const lines = [e.meetingUrl, `From: ${from} — ${subject}`].filter(Boolean);
  return lines.join("\n").slice(0, MAX_DETAILS);
}

export function googleCalendarUrl(e: TimedEvent, details: string): string {
  const dates = e.allDay
    ? `${dateOnly(e.start)}/${dateOnly(e.end)}`
    : `${compact(e.start)}/${compact(e.end)}`;
  const q = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, details });
  const where = e.location ?? e.meetingUrl;
  if (where) q.set("location", where);
  return `https://calendar.google.com/calendar/render?${q}`;
}

export function outlookCalendarUrl(e: TimedEvent, details: string, host: OutlookHost): string {
  const iso = (v: string) =>
    e.allDay ? v : DateTime.fromISO(v).toUTC().toISO({ suppressMilliseconds: true })!;
  const q = new URLSearchParams({
    subject: e.title,
    startdt: iso(e.start),
    enddt: iso(e.end),
    allday: String(e.allDay),
    body: details,
  });
  const where = e.location ?? e.meetingUrl;
  if (where) q.set("location", where);
  return `https://${host}/calendar/0/action/compose?${q}`;
}

/** Links for an event that can still be added: time set, not cancelled, not over (US4-4/6/9). */
export function calendarLinks(
  e: Omit<DetectedEvent, "links">,
  opts: { from: string; subject: string; outlookHost: OutlookHost; now: Date },
): DetectedEvent["links"] {
  if (!e.timeSet || !e.start || !e.end || e.status === "cancelled") return null;
  const endMs = e.allDay ? DateTime.fromISO(e.end).toMillis() : Date.parse(e.end);
  if (endMs <= opts.now.getTime()) return null;
  const timed = { ...e, links: null, start: e.start, end: e.end };
  const details = eventDetails(timed, opts.from, opts.subject);
  return {
    google: googleCalendarUrl(timed, details),
    outlook: outlookCalendarUrl(timed, details, opts.outlookHost),
  };
}
