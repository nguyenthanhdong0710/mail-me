import { describe, expect, it } from "vitest";
import { escapeIcsText, foldLine, icsFile } from "../../src/calendar/ics.js";
import {
  calendarLinks,
  eventDetails,
  googleCalendarUrl,
  MAX_DETAILS,
  outlookCalendarUrl,
} from "../../src/calendar/links.js";
import type { DetectedEvent } from "../../src/domain/types.js";

const timed: DetectedEvent & { start: string; end: string } = {
  title: "Project sync & review #3",
  status: "new",
  source: "ai",
  timeSet: true,
  start: "2026-11-06T07:00:00.000Z",
  end: "2026-11-06T07:45:00.000Z",
  allDay: false,
  timezone: "Asia/Ho_Chi_Minh",
  location: null,
  meetingUrl: "https://teams.microsoft.com/l/meetup-join/1",
  links: null,
};
const allDay = {
  ...timed,
  allDay: true,
  start: "2026-11-10",
  end: "2026-11-12",
  meetingUrl: null,
  location: "Đà Lạt",
};
const key = { accountId: "school", mailbox: "INBOX", uidValidity: "1", uid: "42" };

describe("Google Calendar link", () => {
  it("encodes a timed event in UTC", () => {
    const url = new URL(googleCalendarUrl(timed, "details"));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: "TEMPLATE",
      text: "Project sync & review #3",
      dates: "20261106T070000Z/20261106T074500Z",
      details: "details",
      location: "https://teams.microsoft.com/l/meetup-join/1",
    });
  });

  it("uses exclusive dates for all-day events", () => {
    const url = new URL(googleCalendarUrl(allDay, "d"));
    expect(url.searchParams.get("dates")).toBe("20261110/20261112");
    expect(url.searchParams.get("location")).toBe("Đà Lạt");
  });
});

describe("Outlook calendar link", () => {
  it.each(["outlook.live.com", "outlook.office.com"] as const)("targets %s", (host) => {
    const url = new URL(outlookCalendarUrl(timed, "d", host));
    expect(url.origin + url.pathname).toBe(`https://${host}/calendar/0/action/compose`);
    expect(url.searchParams.get("startdt")).toBe("2026-11-06T07:00:00Z");
    expect(url.searchParams.get("enddt")).toBe("2026-11-06T07:45:00Z");
    expect(url.searchParams.get("allday")).toBe("false");
    expect(url.searchParams.get("subject")).toBe("Project sync & review #3");
  });

  it("passes dates for all-day events", () => {
    const url = new URL(outlookCalendarUrl(allDay, "d", "outlook.live.com"));
    expect(url.searchParams.get("startdt")).toBe("2026-11-10");
    expect(url.searchParams.get("allday")).toBe("true");
  });
});

describe("link encoding and limits (FR-120)", () => {
  it("encodes markup and newlines instead of passing them through", () => {
    const nasty = { ...timed, title: '<script>alert("x")</script>\nline2' };
    const url = googleCalendarUrl(nasty, "a&b=c#d");
    expect(url).not.toContain("<script>");
    expect(url).not.toContain("\n");
    expect(new URL(url).searchParams.get("details")).toBe("a&b=c#d");
  });

  it("caps details at 500 characters", () => {
    const details = eventDetails(timed, "Prof <p@u.edu>", "x".repeat(1000));
    expect(details.length).toBe(MAX_DETAILS);
    expect(
      details.startsWith("https://teams.microsoft.com/l/meetup-join/1\nFrom: Prof <p@u.edu> — x"),
    ).toBe(true);
  });

  it("offers no links for unset, cancelled or past events", () => {
    const opts = {
      from: "a",
      subject: "s",
      outlookHost: "outlook.live.com" as const,
      now: new Date("2026-11-01T00:00:00Z"),
    };
    expect(calendarLinks(timed, opts)).not.toBeNull();
    expect(calendarLinks({ ...timed, status: "cancelled" }, opts)).toBeNull();
    expect(calendarLinks({ ...timed, timeSet: false }, opts)).toBeNull();
    expect(calendarLinks(timed, { ...opts, now: new Date("2026-11-06T07:45:00Z") })).toBeNull();
  });
});

describe(".ics file (RFC 5545)", () => {
  it("writes a PUBLISH calendar with a stable UID", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const ics = icsFile([timed, allDay], key, now, () => "From: Prof — Sync");
    expect(ics).toMatchSnapshot();
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("DTSTART:20261106T070000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261110");
    expect(ics).toContain("DTEND;VALUE=DATE:20261112");
    expect(ics).toBe(icsFile([timed, allDay], key, now, () => "From: Prof — Sync"));
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it("escapes text values", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe(String.raw`a\\b\;c\,d\n` + "e");
  });

  it("folds long lines without splitting characters", () => {
    const folded = foldLine(`SUMMARY:${"Đ".repeat(60)}`);
    for (const l of folded.split("\r\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"Đ".repeat(60)}`);
  });
});
