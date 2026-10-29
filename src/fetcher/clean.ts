import { convert } from "html-to-text";
import { DateTime } from "luxon";
import { simpleParser, type AddressObject } from "mailparser";
import type { Address } from "../domain/types.js";

export interface CleanedEmail {
  messageId: string | null;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  receivedAt: Date;
  /** ISO time with the sender's UTC offset when the Date header has one. */
  sentAt: string;
  calendarParts: string[];
  text: string;
  truncated: boolean;
  attachments: string[];
  selfSentMarker: string | null;
}

const REPLY_HEADER = /^(On\s.+\bwrote:|-{2,}\s*Original Message\s*-{2,}|From:\s.+\nSent:\s.+)$/im;

export function htmlToPlain(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
      // Keep the sender's casing; the default upper-cases headings and table headers.
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
      { selector: "table", options: { uppercaseHeaderCells: false } },
    ],
  });
}

/** Drops quoted reply chains, which are mostly noise for summaries (research R3). */
export function stripQuotedReplies(text: string): string {
  const match = REPLY_HEADER.exec(text);
  const head = match ? text.slice(0, match.index) : text;
  return head
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+$/gm, "")
    .replace(/[ \t\u00a0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  // Avoid splitting a surrogate pair.
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

function firstAddress(from: AddressObject | AddressObject[] | undefined): Address {
  const obj = Array.isArray(from) ? from[0] : from;
  const first = obj?.value[0];
  const address = first?.address?.toLowerCase() ?? "unknown@unknown";
  return first?.name ? { name: first.name, address } : { address };
}

/** Names come from the sender: strip control characters and keep them short (FR-128). */
export function sanitizeName(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64)
  );
}

function addressList(field: AddressObject | AddressObject[] | undefined): Address[] {
  const objs = Array.isArray(field) ? field : field ? [field] : [];
  const out: Address[] = [];
  const walk = (entries: AddressObject["value"]) => {
    for (const e of entries) {
      // Group syntax ("Team: a@x, b@y;") nests addresses.
      if (e.group) walk(e.group);
      else if (e.address) {
        const name = e.name ? sanitizeName(e.name) : "";
        out.push(
          name ? { name, address: e.address.toLowerCase() } : { address: e.address.toLowerCase() },
        );
      }
    }
  };
  for (const o of objs) walk(o.value);
  return out;
}

/** Keeps the sender's offset from the raw Date header, falling back to UTC. */
function sentAtFrom(rawDate: string | undefined, date: Date): string {
  const parsed = rawDate ? DateTime.fromRFC2822(rawDate.trim(), { setZone: true }) : null;
  return parsed?.isValid ? parsed.toISO()! : date.toISOString();
}

const MAX_CALENDAR_PARTS = 3;
const MAX_CALENDAR_BYTES = 64 * 1024;

function headerString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export async function parseAndClean(
  source: Buffer,
  opts: { maxBodyChars: number; fallbackDate: Date },
): Promise<CleanedEmail> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  // mailparser derives `text` from HTML-only mail with its own (upper-casing) settings,
  // so convert the HTML ourselves whenever it is present.
  const rawText = parsed.html ? htmlToPlain(parsed.html) : (parsed.text ?? "");
  const body = normalizeWhitespace(stripQuotedReplies(rawText));
  const { text, truncated } = truncate(body, opts.maxBodyChars);
  const receivedAt = parsed.date ?? opts.fallbackDate;
  const rawDate = parsed.headerLines.find((h) => h.key === "date")?.line.replace(/^date:\s*/i, "");
  const calendar = parsed.attachments.filter(
    (a) => a.contentType === "text/calendar" || a.filename?.toLowerCase().endsWith(".ics"),
  );

  return {
    messageId: parsed.messageId ?? null,
    from: firstAddress(parsed.from),
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    subject: parsed.subject?.trim() || "(no subject)",
    receivedAt,
    sentAt: sentAtFrom(rawDate, receivedAt),
    calendarParts: calendar
      .filter((a) => a.size <= MAX_CALENDAR_BYTES)
      .slice(0, MAX_CALENDAR_PARTS)
      .map((a) => a.content.toString("utf8")),
    text,
    truncated,
    // Invitations are shown as an Event section, not as attachments.
    attachments: parsed.attachments
      .filter((a) => !calendar.includes(a) || a.filename)
      .map((a) => a.filename ?? "(unnamed attachment)"),
    selfSentMarker: headerString(parsed.headers.get("x-mail-me")),
  };
}
