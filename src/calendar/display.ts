import { DateTime } from "luxon";
import type { DetectedEvent } from "../domain/types.js";

// How events read in reports (contracts/report.contract.md). Plain text; channels escape it.

const DAY = "ccc d LLL";

function local(iso: string, zone: string): DateTime {
  return DateTime.fromISO(iso, { setZone: true }).setZone(zone).setLocale("en");
}

/** e.g. `Thu 6 Nov, 14:00–14:45 (Asia/Ho_Chi_Minh)` in the user's zone. */
export function formatWhen(e: DetectedEvent, userZone: string): string {
  if (!e.timeSet || !e.start || !e.end) return "time not set";
  if (e.allDay) {
    const start = DateTime.fromISO(e.start).setLocale("en");
    const last = DateTime.fromISO(e.end).minus({ days: 1 }).setLocale("en");
    return last <= start
      ? `${start.toFormat(DAY)} (all day)`
      : `${start.toFormat(DAY)} – ${last.toFormat(DAY)} (all day)`;
  }
  const s = local(e.start, userZone);
  const en = local(e.end, userZone);
  const range = s.hasSame(en, "day")
    ? `${s.toFormat(DAY)}, ${s.toFormat("HH:mm")}–${en.toFormat("HH:mm")}`
    : `${s.toFormat(DAY)} ${s.toFormat("HH:mm")} – ${en.toFormat(DAY)} ${en.toFormat("HH:mm")}`;
  if (e.timezone === userZone) return `${range} (${userZone})`;
  // Stated in another zone: keep it visible next to the user's local time.
  const original = local(e.start, e.timezone).toFormat("HH:mm");
  return `${range} ${userZone} (${original} ${e.timezone})`;
}

const STATUS: Record<DetectedEvent["status"], string> = {
  new: "",
  rescheduled: " — Rescheduled",
  cancelled: " — Cancelled",
};

export function eventHeadline(e: DetectedEvent, userZone: string): string {
  return `${e.title} — ${formatWhen(e, userZone)}${STATUS[e.status]}`;
}

export const SCHEDULER_FAILED_TEXT = "⚠ Event detection failed, check the email for dates";
