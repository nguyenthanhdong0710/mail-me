import { describe, expect, it } from "vitest";
import type { AccountConfig } from "../../src/config/load.js";
import { createLogger } from "../../src/lib/logger.js";
import type { Pipeline } from "../../src/orchestrator/pipeline.js";
import {
  MAX_BACKOFF_MS,
  nextDelay,
  startRetentionJob,
  startScheduler,
  type Timers,
} from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const logger = createLogger({ level: "silent" });

/** Manual timers: `fire()` runs every due callback and waits for the runs to settle. */
class ManualTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clearTimeout = (h: unknown) => void this.pending.delete(h as number);
  delays(): number[] {
    return [...this.pending.values()].map((t) => t.ms);
  }
  async fire(): Promise<void> {
    const due = [...this.pending.values()];
    this.pending.clear();
    due.forEach((t) => t.fn());
    await new Promise((r) => setTimeout(r, 0));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const account = (id: string) => ({ id }) as AccountConfig;

describe("nextDelay", () => {
  it("uses the interval when healthy and backs off exponentially, capped", () => {
    expect(nextDelay(300_000, 0)).toBe(300_000);
    expect(nextDelay(300_000, 1)).toBe(600_000);
    expect(nextDelay(300_000, 2)).toBe(1_200_000);
    expect(nextDelay(300_000, 10)).toBe(MAX_BACKOFF_MS);
  });
});

describe("startScheduler", () => {
  it("runs one loop per account and backs off only the failing one", async () => {
    const polls: string[] = [];
    const pipeline = {
      pollAccount: async (a: AccountConfig) => {
        polls.push(a.id);
        if (a.id === "broken") throw new Error("auth failed");
      },
    } as unknown as Pipeline;
    const timers = new ManualTimers();
    const stop = startScheduler(pipeline, [account("ok"), account("broken")], 1000, logger, timers);
    await settle();
    expect(polls.sort()).toEqual(["broken", "ok"]);
    expect(timers.delays().sort((a, b) => a - b)).toEqual([1000, 2000]);

    await timers.fire();
    expect(timers.delays().sort((a, b) => a - b)).toEqual([1000, 4000]);
    await stop();
    expect(timers.pending.size).toBe(0);
  });

  it("never overlaps runs of the same account", async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const pipeline = {
      pollAccount: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => (release = r));
        active--;
      },
    } as unknown as Pipeline;
    const timers = new ManualTimers();
    const stop = startScheduler(pipeline, [account("a")], 1000, logger, timers);
    await settle();
    expect(timers.pending.size).toBe(0); // next run is only scheduled after this one ends
    release();
    await settle();
    expect(timers.pending.size).toBe(1);
    await timers.fire();
    release();
    await stop();
    expect(maxActive).toBe(1);
  });
});

describe("startRetentionJob", () => {
  it("purges at start and then once a day", async () => {
    const store = new SqliteStore(":memory:");
    const now = new Date("2026-10-29T00:00:00Z");
    store.recordProcessed({
      key: { accountId: "a", mailbox: "INBOX", uidValidity: 1, uid: 1 },
      messageId: null,
      sender: "x@y",
      subject: "old",
      decision: "LLM",
      category: "SPAM",
      confidence: 0.9,
      outcome: "SKIPPED",
      tokensIn: 1,
      tokensOut: 1,
      processedAt: "2026-01-01T00:00:00Z",
    });
    const timers = new ManualTimers();
    const stop = startRetentionJob(store, 90, logger, () => now, timers);
    await settle();
    expect(
      store.getProcessed({ accountId: "a", mailbox: "INBOX", uidValidity: 1, uid: 1 }),
    ).toBeNull();
    expect(timers.delays()).toEqual([86_400_000]);
    await stop();
  });
});
