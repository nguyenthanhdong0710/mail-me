import { describe, expect, it } from "vitest";
import { retry, Semaphore } from "../../src/lib/retry.js";

const noSleep = { sleep: async () => {}, random: () => 0 };

describe("retry", () => {
  it("returns the first success", async () => {
    let calls = 0;
    const value = await retry(async () => {
      calls++;
      if (calls < 3) throw new Error("flaky");
      return "ok";
    }, noSleep);
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows after the last attempt", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error("down");
        },
        { ...noSleep, attempts: 2 },
      ),
    ).rejects.toThrow("down");
    expect(calls).toBe(2);
  });

  it("stops early when shouldRetry says no", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error("fatal");
        },
        { ...noSleep, shouldRetry: () => false },
      ),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  it("backs off exponentially", async () => {
    const delays: number[] = [];
    await expect(
      retry(
        async () => {
          throw new Error("x");
        },
        { attempts: 4, baseMs: 100, random: () => 1, sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400]);
  });
});

describe("Semaphore", () => {
  it("never exceeds its limit", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });
});
