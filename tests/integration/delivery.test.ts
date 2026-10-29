import { beforeEach, describe, expect, it } from "vitest";
import { dispatch, type DispatchDeps } from "../../src/courier/dispatcher.js";
import type { ChannelName, DraftRecord, Report } from "../../src/domain/types.js";
import { createLogger } from "../../src/lib/logger.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { FakeChannel, FakeClock, sampleReport } from "../fakes/index.js";

const logger = createLogger({ level: "silent" });
const fast = { attempts: 2, sleep: async () => {} };

function draftFor(report: Report): DraftRecord {
  return {
    key: report.key,
    messageId: report.original.messageId,
    sender: report.original.from.address,
    subject: report.original.subject,
    decision: "LLM",
    category: "IMPORTANT",
    confidence: 0.9,
    tokensIn: 120,
    tokensOut: 40,
    costUsd: null,
  };
}

describe("dispatcher (FR-024)", () => {
  let store: SqliteStore;
  let email: FakeChannel;
  let telegram: FakeChannel;
  let clock: FakeClock;
  let maxAttempts: number;
  const report = sampleReport();

  const deps = (channels: ChannelName[] = ["email", "telegram"]): DispatchDeps => ({
    store,
    channels: new Map(channels.map((c) => [c, c === "email" ? email : telegram] as const)),
    clock,
    logger,
    maxAttempts,
    retry: fast,
  });
  /** One poll's worth of draining, as the pipeline does at the start of every poll. */
  const drain = async (d = deps()) => {
    for (const p of store.listPendingReports()) await dispatch(p, d);
  };
  const deliveries = () =>
    Object.fromEntries(
      (store.listPendingReports()[0]?.deliveries ?? []).map((r) => [r.channel, r]),
    );

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    email = new FakeChannel("email");
    telegram = new FakeChannel("telegram");
    clock = new FakeClock();
    maxAttempts = 10;
    store.savePendingReport(report, draftFor(report), ["email", "telegram"]);
  });

  it("delivers to both channels and completes the report", async () => {
    await drain();
    expect(email.delivered).toHaveLength(1);
    expect(telegram.delivered).toHaveLength(1);
    expect(store.listPendingReports()).toHaveLength(0);
    expect(store.getProcessed(report.key)?.outcome).toBe("FORWARDED");
  });

  it("retries only the failed channel, never duplicating the other", async () => {
    telegram.failNext(2);
    await drain();
    expect(deliveries()).toMatchObject({
      email: { status: "DELIVERED", attempts: 1 },
      telegram: { status: "PENDING", attempts: 1, lastError: "telegram down" },
    });
    expect(store.isProcessed(report.key, null)).toBe(false);

    await drain();
    expect(email.delivered).toHaveLength(1);
    expect(telegram.delivered).toHaveLength(1);
    expect(store.getProcessed(report.key)?.outcome).toBe("FORWARDED");
  });

  it("resumes from the stored report after a restart mid-delivery", async () => {
    telegram.failNext(2);
    await drain();

    // Restart: new channel instances, same store. The report comes from pending_reports.
    email = new FakeChannel("email");
    telegram = new FakeChannel("telegram");
    await drain();
    expect(email.delivered).toHaveLength(0);
    expect(telegram.delivered).toEqual([report]);
    expect(store.listPendingReports()).toHaveLength(0);
  });

  it("passes stored split progress back to the channel", async () => {
    const [pending] = store.listPendingReports();
    store.updateDelivery({
      ...pending!.deliveries.find((d) => d.channel === "telegram")!,
      partsSent: 2,
    });
    await drain();
    expect(telegram.progress).toEqual([{ partsSent: 2 }]);
  });

  it("honours retryAfterMs before trying the channel again", async () => {
    telegram.failNext(1, true, 30_000);
    await drain();
    expect(telegram.progress).toHaveLength(1); // no in-poll retry after a server-requested wait
    expect(deliveries().telegram?.nextAttemptAt).toBe(
      new Date(clock.now().getTime() + 30_000).toISOString(),
    );

    await drain(); // too early
    expect(telegram.progress).toHaveLength(1);

    clock.advance(30_001);
    await drain();
    expect(telegram.delivered).toHaveLength(1);
  });

  it("gives up a channel after max_attempts and completes the message", async () => {
    maxAttempts = 2;
    telegram.failNext(4);
    await drain();
    expect(deliveries().telegram).toMatchObject({ status: "PENDING", attempts: 1 });
    await drain();
    expect(store.listPendingReports()).toHaveLength(0);
    expect(store.getProcessed(report.key)?.outcome).toBe("FORWARDED");
    expect(email.delivered).toHaveLength(1);
  });

  it("records DELIVERY_FAILED when every channel gives up", async () => {
    email.failNext(1, false);
    telegram.failNext(1, false);
    await drain();
    expect(store.getProcessed(report.key)?.outcome).toBe("DELIVERY_FAILED");
    expect(store.listPendingReports()).toHaveLength(0);
  });

  it("gives up a channel that is no longer enabled", async () => {
    await drain(deps(["email"]));
    expect(email.delivered).toHaveLength(1);
    expect(store.getProcessed(report.key)?.outcome).toBe("FORWARDED");
  });

  it("marks a fallback report FALLBACK_FORWARDED", async () => {
    const fb = sampleReport({ key: { ...report.key, uid: "6" }, kind: "FALLBACK", analysis: null });
    store.savePendingReport(fb, draftFor(fb), ["email"]);
    await drain();
    expect(store.getProcessed(fb.key)?.outcome).toBe("FALLBACK_FORWARDED");
  });
});
