import { describe, expect, it } from "vitest";
import { detectEvents, normalizeEvents } from "../../src/agents/scheduler.js";
import type { SchedulerResult } from "../../src/domain/types.js";
import { FakeLlm } from "../fakes/index.js";

type Ev = SchedulerResult["events"][number];
const ev = (over: Partial<Ev> = {}): Ev => ({
  title: "Sync",
  status: "new",
  time_known: true,
  all_day: false,
  start_local: "2026-11-06T14:00",
  end_local: null,
  duration_minutes: null,
  timezone: null,
  location: null,
  meeting_url: null,
  ...over,
});
const ZONE = "Asia/Ho_Chi_Minh";
const one = (over: Partial<Ev>) => normalizeEvents({ events: [ev(over)] }, ZONE)[0]!;

describe("Scheduler normalization (FR-115, FR-116)", () => {
  it("uses the configured zone when the email states none, with a 60-minute default", () => {
    expect(one({})).toMatchObject({
      timeSet: true,
      start: "2026-11-06T07:00:00.000Z",
      end: "2026-11-06T08:00:00.000Z",
      timezone: ZONE,
      source: "ai",
    });
  });

  it("keeps a stated zone", () => {
    expect(one({ timezone: "Europe/London", start_local: "2026-11-06T09:00" })).toMatchObject({
      start: "2026-11-06T09:00:00.000Z",
      timezone: "Europe/London",
    });
  });

  it("ignores an invalid zone", () => {
    expect(one({ timezone: "Mars/Olympus" }).timezone).toBe(ZONE);
  });

  it("uses the stated end, else the duration", () => {
    expect(one({ end_local: "2026-11-06T14:45" }).end).toBe("2026-11-06T07:45:00.000Z");
    expect(one({ duration_minutes: 90 }).end).toBe("2026-11-06T08:30:00.000Z");
    expect(one({ end_local: "2026-11-06T13:00", duration_minutes: 30 }).end).toBe(
      "2026-11-06T07:30:00.000Z",
    );
  });

  it("handles a DST change in the stated zone", () => {
    // London leaves summer time on 25 Oct 2026: 09:00 is UTC+1 before, UTC after.
    expect(one({ timezone: "Europe/London", start_local: "2026-10-24T09:00" }).start).toBe(
      "2026-10-24T08:00:00.000Z",
    );
    expect(one({ timezone: "Europe/London", start_local: "2026-10-26T09:00" }).start).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("makes all-day and multi-day events end the day after the last day", () => {
    expect(one({ all_day: true, start_local: "2026-11-10" })).toMatchObject({
      allDay: true,
      start: "2026-11-10",
      end: "2026-11-11",
    });
    expect(one({ all_day: true, start_local: "2026-11-10", end_local: "2026-11-12" }).end).toBe(
      "2026-11-13",
    );
    expect(one({ all_day: false, start_local: "2026-11-10" }).allDay).toBe(true);
  });

  it("marks events without a usable time", () => {
    expect(one({ time_known: false, start_local: null })).toMatchObject({
      timeSet: false,
      start: null,
      end: null,
    });
  });

  it("drops meeting links that are not https", () => {
    expect(one({ meeting_url: "http://evil.example/x" }).meetingUrl).toBeNull();
    expect(one({ meeting_url: "javascript:alert(1)" }).meetingUrl).toBeNull();
    expect(one({ meeting_url: "https://zoom.us/j/1" }).meetingUrl).toBe("https://zoom.us/j/1");
  });
});

describe("detectEvents links and limits (FR-115, FR-117)", () => {
  const run = (events: Ev[], now = "2026-11-02T00:00:00Z") =>
    detectEvents(
      new FakeLlm({ scheduler: () => ({ events }) }),
      {
        from: { address: "a@b.c" },
        subject: "S",
        text: "t",
        attachments: [],
        sentAt: "2026-11-02T09:00:00+07:00",
        calendarParts: [],
      },
      { enabled: true, timezone: ZONE, outlookHost: "outlook.live.com", now: new Date(now) },
    );

  it("gives links to upcoming events only", async () => {
    const out = await run([
      ev(),
      ev({ status: "cancelled" }),
      ev({ time_known: false, start_local: null }),
    ]);
    expect(out.events.map((e) => !!e.links)).toEqual([true, false, false]);
    const past = await run([ev()], "2026-11-07T00:00:00Z");
    expect(past.events[0]!.links).toBeNull();
  });

  it("keeps the first 3 events and counts the rest", async () => {
    const out = await run(Array.from({ length: 5 }, (_, i) => ev({ title: `E${i}` })));
    expect(out.events.map((e) => e.title)).toEqual(["E0", "E1", "E2"]);
    expect(out.eventsOmitted).toBe(2);
  });

  it("makes no AI call when disabled", async () => {
    const llm = new FakeLlm();
    const out = await detectEvents(
      llm,
      {
        from: { address: "a@b.c" },
        subject: "S",
        text: "t",
        attachments: [],
        sentAt: "x",
        calendarParts: [],
      },
      { enabled: false, timezone: ZONE, outlookHost: "outlook.live.com", now: new Date() },
    );
    expect(out.events).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});
