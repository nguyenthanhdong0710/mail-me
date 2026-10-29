import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { DetectedEvent, MessageKey } from "../domain/types.js";

// A small RFC 5545 writer (research R11). METHOD:PUBLISH makes calendar apps add a plain event
// and never send replies to the organizer.

/** Escapes TEXT values: backslash, semicolon, comma and newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets without splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + bytes > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

const utc = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");

export function icsFile(
  events: DetectedEvent[],
  key: MessageKey,
  now: Date,
  details: (e: DetectedEvent) => string,
): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mail-Me//EN", "METHOD:PUBLISH"];
  events.forEach((e, i) => {
    if (!e.start || !e.end) return;
    const uid = createHash("sha256")
      .update(`${key.accountId}/${key.mailbox}/${key.uidValidity}/${key.uid}/${i}`)
      .digest("hex")
      .slice(0, 32);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}@mail-me`,
      `DTSTAMP:${utc(now.toISOString())}`,
      e.allDay ? `DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}` : `DTSTART:${utc(e.start)}`,
      e.allDay ? `DTEND;VALUE=DATE:${e.end.replace(/-/g, "")}` : `DTEND:${utc(e.end)}`,
      `SUMMARY:${escapeIcsText(e.title)}`,
      `DESCRIPTION:${escapeIcsText(details(e))}`,
    );
    if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    if (e.meetingUrl) lines.push(`URL:${e.meetingUrl}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
