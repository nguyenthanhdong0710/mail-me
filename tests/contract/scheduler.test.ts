import { describe, expect, it } from "vitest";
import { detectEvents } from "../../src/agents/scheduler.js";
import { SchedulerSchema } from "../../src/domain/types.js";
import { FakeLlm } from "../fakes/index.js";
import { calendarEmail } from "../fixtures/calendar/load.js";

const event = (over: Record<string, unknown> = {}) => ({
  title: "Project sync",
  status: "new",
  time_known: true,
  all_day: false,
  start_local: "2026-11-06T14:00",
  end_local: null,
  duration_minutes: 45,
  timezone: null,
  location: null,
  meeting_url: "https://teams.microsoft.com/l/meetup-join/1",
  ...over,
});

describe("Scheduler output schema (contracts/scheduler.contract.md)", () => {
  it("accepts valid output, including all-day and unknown times", () => {
    expect(
      SchedulerSchema.safeParse({
        events: [
          event(),
          event({ all_day: true, start_local: "2026-11-10", duration_minutes: null }),
          event({ time_known: false, start_local: null, duration_minutes: null }),
        ],
      }).success,
    ).toBe(true);
    expect(SchedulerSchema.safeParse({ events: [] }).success).toBe(true);
  });

  it.each([
    ["an empty title", { title: "" }],
    ["a title over 120 chars", { title: "x".repeat(121) }],
    ["an unknown status", { status: "maybe" }],
    ["an offset in the time", { start_local: "2026-11-06T14:00+07:00" }],
    ["a duration over 14 days", { duration_minutes: 60 * 24 * 15 }],
    ["a long location", { location: "x".repeat(201) }],
    ["a long link", { meeting_url: `https://x.y/${"a".repeat(500)}` }],
    ["a long zone", { timezone: "x".repeat(65) }],
  ])("rejects %s", (_name, over) => {
    expect(SchedulerSchema.safeParse({ events: [event(over)] }).success).toBe(false);
  });

  it("rejects more than 5 events", () => {
    expect(
      SchedulerSchema.safeParse({ events: Array.from({ length: 6 }, () => event()) }).success,
    ).toBe(false);
  });

  it("keeps the email inside <email> and the context outside it", async () => {
    const llm = new FakeLlm({ scheduler: () => ({ events: [] }) });
    const email = await calendarEmail("injection-event");
    await detectEvents(llm, email, {
      enabled: true,
      timezone: "Asia/Ho_Chi_Minh",
      outlookHost: "outlook.live.com",
      now: new Date("2026-11-02T00:00:00Z"),
    });
    const { system, user } = llm.calls[0]!;
    expect(system).toContain("untrusted data");
    expect(user).toMatch(
      /<\/email>\n<sent_at>2026-11-02T09:00:00.000\+07:00<\/sent_at>\n<user_timezone>Asia\/Ho_Chi_Minh<\/user_timezone>$/,
    );
    expect(user.match(/<email>/g)).toHaveLength(1);
  });
});
