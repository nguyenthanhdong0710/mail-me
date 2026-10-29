import ICAL from "ical.js";
import { DateTime } from "luxon";
import { isTimeZone } from "../config/schema.js";
import type { DetectedEvent, EventStatus } from "../domain/types.js";

/** An event read from a calendar invitation, before links are added (FR-114). */
export type InviteEvent = Omit<DetectedEvent, "links">;

const URL_PROPS = ["x-microsoft-skypeteamsmeetingurl", "x-google-conference", "url"];

function firstHttpsUrl(text: string | null | undefined): string | null {
  const m = /https:\/\/[^\s<>"']+/i.exec(text ?? "");
  return m ? m[0].slice(0, 500) : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Converts an iCal time to an instant (or a date for all-day), honoring its zone. */
function toInstant(
  t: ICAL.Time,
  tzidParam: string | undefined,
  fallbackZone: string,
): { iso: string; zone: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (t.isDate) return { iso: `${t.year}-${pad(t.month)}-${pad(t.day)}`, zone: fallbackZone };
  const tzid = t.zone?.tzid;
  if (tzid === "UTC") return { iso: t.toJSDate().toISOString(), zone: "UTC" };
  if (tzid && tzid !== "floating") {
    // Defined by a VTIMEZONE in the file (e.g. Outlook's Windows zone names).
    return { iso: t.toJSDate().toISOString(), zone: isTimeZone(tzid) ? tzid : fallbackZone };
  }
  // A TZID without a VTIMEZONE is left floating by ical.js; resolve IANA names ourselves.
  const zone = tzidParam && isTimeZone(tzidParam) ? tzidParam : fallbackZone;
  const dt = DateTime.fromObject(
    { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
    { zone },
  );
  return { iso: dt.toUTC().toISO()!, zone };
}

/**
 * Parses `text/calendar` parts into events (002 contracts/scheduler.contract.md). Throws on a
 * file that is not iCalendar, so the caller can mark detection as failed.
 */
export function parseInvites(parts: string[], fallbackZone: string): InviteEvent[] {
  const events: InviteEvent[] = [];
  for (const part of parts) {
    ICAL.TimezoneService.reset();
    const cal = new ICAL.Component(ICAL.parse(part));
    for (const tz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
    const method = String(cal.getFirstPropertyValue("method") ?? "").toUpperCase();

    for (const vevent of cal.getAllSubcomponents("vevent")) {
      const ev = new ICAL.Event(vevent);
      const statusProp = String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase();
      const status: EventStatus =
        method === "CANCEL" || statusProp === "CANCELLED"
          ? "cancelled"
          : method === "REQUEST" && ev.sequence > 0
            ? "rescheduled"
            : "new";
      const meetingUrl =
        URL_PROPS.map((p) => firstHttpsUrl(asText(vevent.getFirstPropertyValue(p)))).find(
          Boolean,
        ) ??
        firstHttpsUrl(ev.description) ??
        null;

      if (!ev.startDate) {
        events.push({
          title: (asText(ev.summary) ?? "Event").slice(0, 120),
          status,
          source: "invitation",
          timeSet: false,
          start: null,
          end: null,
          allDay: false,
          timezone: fallbackZone,
          location: asText(ev.location)?.slice(0, 200) ?? null,
          meetingUrl,
        });
        continue;
      }
      const tzid = (name: string) => {
        const v = vevent.getFirstProperty(name)?.getParameter("tzid");
        return typeof v === "string" ? v : undefined;
      };
      const start = toInstant(ev.startDate, tzid("dtstart"), fallbackZone);
      // ICAL.Event derives endDate from DTEND or DURATION; with neither it equals the start.
      let end = toInstant(ev.endDate, tzid("dtend") ?? tzid("dtstart"), fallbackZone).iso;
      if (end <= start.iso) {
        end = ev.startDate.isDate
          ? DateTime.fromISO(start.iso).plus({ days: 1 }).toISODate()!
          : DateTime.fromISO(start.iso).plus({ minutes: 60 }).toUTC().toISO()!;
      }
      events.push({
        title: (asText(ev.summary) ?? "Event").slice(0, 120),
        status,
        source: "invitation",
        timeSet: true,
        start: start.iso,
        end,
        allDay: ev.startDate.isDate,
        timezone: start.zone,
        location: asText(ev.location)?.slice(0, 200) ?? null,
        meetingUrl,
      });
    }
  }
  return events;
}
