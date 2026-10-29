import { describe, expect, it } from "vitest";
import { eventMatches, scoreScheduler } from "../../scripts/eval-scheduler.js";

const det = (title: string, start: string, end: string) => ({ title, start, end, timeSet: true });
const x = { title: "sync", start: "2026-11-06T07:00:00Z", end: "2026-11-06T07:45:00Z" };

describe("eval-scheduler score (SC-106)", () => {
  it("matches title, start and end", () => {
    expect(
      eventMatches(det("Project sync", "2026-11-06T07:00:00.000Z", "2026-11-06T07:45:00.000Z"), x),
    ).toBe(true);
    expect(
      eventMatches(det("Project sync", "2026-11-06T07:00:00Z", "2026-11-06T08:00:00Z"), x),
    ).toBe(false);
    expect(eventMatches(det("Lunch", "2026-11-06T07:00:00Z", "2026-11-06T07:45:00Z"), x)).toBe(
      false,
    );
    expect(
      eventMatches(
        { ...det("sync", "2026-11-06T07:00:00Z", "2026-11-06T07:45:00Z"), timeSet: false },
        x,
      ),
    ).toBe(false);
  });

  it("passes at 90% with no false positives", () => {
    const good = { file: "a", expected: [x], detected: [det("sync", x.start, x.end)] };
    const samples = [
      ...Array.from({ length: 9 }, () => good),
      { file: "b", expected: [x], detected: [] },
    ];
    expect(scoreScheduler(samples)).toMatchObject({ accuracy: 0.9, passed: true });
    const fp = { file: "c", expected: null, detected: [det("x", x.start, x.end)] };
    expect(scoreScheduler([...samples, fp])).toMatchObject({ falsePositives: 1, passed: false });
  });
});
