import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/load.js";
import { selfSentMarker } from "../../src/courier/channels/email/smtp-channel.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer, promotion } from "../fakes/index.js";
import { eml, fixture } from "../fixtures/load.js";

const logger = createLogger({ level: "silent" });
const fast = { attempts: 2, sleep: async () => {} };

describe("pipeline (US1)", () => {
  let server: FakeMailServer;
  let store: SqliteStore;
  let llm: FakeLlm;
  let channel: FakeChannel;
  let clock: FakeClock;
  let config: AppConfig;

  const pipeline = () =>
    new Pipeline({
      config,
      store,
      llm,
      channels: new Map([["email", channel]]),
      sources: server.factory(),
      clock,
      logger,
      retry: fast,
    });
  const poll = (p = pipeline()) => runOnce(p, config.accounts, logger);
  const key = (uid: number) => ({ accountId: "school", uidValidity: 1, uid });

  beforeEach(async () => {
    server = new FakeMailServer();
    store = new SqliteStore(":memory:");
    llm = new FakeLlm();
    channel = new FakeChannel("email");
    clock = new FakeClock();
    config = testConfig();
    await poll(); // first run establishes the baseline on an empty mailbox
  });

  it("delivers one summary for an important email", async () => {
    const uid = server.deliver("school", fixture("important-deadline.eml"));
    await poll();

    expect(channel.delivered).toHaveLength(1);
    const report = channel.delivered[0]!;
    expect(report.kind).toBe("SUMMARY");
    expect(report.source.label).toBe("School");
    expect(report.original.subject).toBe("Assignment 3 due Friday");
    expect(report.actionNeeded).toBe(true);
    expect(store.getProcessed(key(uid))).toMatchObject({
      outcome: "FORWARDED",
      category: "IMPORTANT",
    });
  });

  it("does not process the same email twice, even after a restart", async () => {
    server.deliver("school", fixture("important-deadline.eml"));
    await poll();
    await poll();
    await poll(pipeline()); // a new Pipeline over the same store = a restart
    expect(channel.delivered).toHaveLength(1);
    expect(llm.callsFor("analyst")).toBe(1);
  });

  it("only processes mail that arrives after the first start", async () => {
    const fresh = new FakeMailServer();
    fresh.deliver("school", fixture("important-deadline.eml"));
    server = fresh;
    store = new SqliteStore(":memory:");
    await poll();
    expect(channel.delivered).toHaveLength(0);

    server.deliver("school", eml({ subject: "New one" }));
    await poll();
    expect(channel.delivered.map((r) => r.original.subject)).toEqual(["New one"]);
  });

  it("honours the look-back window on the first run (FR-019)", async () => {
    server = new FakeMailServer();
    store = new SqliteStore(":memory:");
    config = testConfig((c) => {
      (c.accounts as Array<Record<string, unknown>>)[0]!.lookback_hours = 24;
    });
    const now = clock.now().getTime();
    server.deliver("school", eml({ subject: "Too old" }), { date: new Date(now - 48 * 3_600_000) });
    server.deliver("school", eml({ subject: "Recent" }), { date: new Date(now - 2 * 3_600_000) });
    await poll();
    expect(channel.delivered.map((r) => r.original.subject)).toEqual(["Recent"]);
  });

  it("sends a fallback report when analysis fails", async () => {
    llm.handlers.analyst = () => {
      throw new Error("provider down");
    };
    const uid = server.deliver("school", fixture("important-deadline.eml"));
    await poll();
    expect(channel.delivered[0]).toMatchObject({ kind: "FALLBACK", analysis: null });
    expect(store.getProcessed(key(uid))?.outcome).toBe("FALLBACK_FORWARDED");
  });

  it("fails open to IMPORTANT when the gatekeeper fails", async () => {
    llm.handlers.gatekeeper = () => "not json";
    server.deliver("school", fixture("promo.eml"));
    await poll();
    expect(channel.delivered).toHaveLength(1);
  });

  it("skips promotions and records why", async () => {
    llm.handlers.gatekeeper = () => promotion(0.95);
    const uid = server.deliver("school", fixture("promo.eml"));
    await poll();
    expect(channel.delivered).toHaveLength(0);
    expect(llm.callsFor("analyst")).toBe(0);
    expect(store.getProcessed(key(uid))).toMatchObject({
      outcome: "SKIPPED",
      category: "PROMOTION",
    });
  });

  it("forwards a low-confidence promotion (FR-005)", async () => {
    llm.handlers.gatekeeper = () => promotion(0.4);
    server.deliver("school", fixture("promo.eml"));
    await poll();
    expect(channel.delivered).toHaveLength(1);
  });

  it("retries a failed send on the next poll without calling the AI again", async () => {
    channel.failNext(2); // both in-poll attempts fail
    const uid = server.deliver("school", fixture("important-deadline.eml"));
    await poll();
    expect(channel.delivered).toHaveLength(0);
    expect(store.isProcessed(key(uid), null)).toBe(false);
    expect(store.hasPendingReport(key(uid))).toBe(true);

    await poll();
    expect(channel.delivered).toHaveLength(1);
    expect(store.getProcessed(key(uid))?.outcome).toBe("FORWARDED");
    expect(llm.callsFor("gatekeeper")).toBe(1);
    expect(llm.callsFor("analyst")).toBe(1);
  });

  it("gives up on a permanent delivery failure and records it", async () => {
    channel.failNext(1, false);
    const uid = server.deliver("school", fixture("important-deadline.eml"));
    await poll();
    expect(store.getProcessed(key(uid))?.outcome).toBe("DELIVERY_FAILED");
    await poll();
    expect(channel.delivered).toHaveLength(0);
  });

  it("skips our own report emails without calling the AI", async () => {
    const marker = selfSentMarker(store.getInstallId());
    const uid = server.deliver(
      "school",
      eml({ subject: "[AI Summary] x", headers: { "X-Mail-Me": marker } }),
    );
    await poll();
    expect(llm.calls).toHaveLength(0);
    expect(channel.delivered).toHaveLength(0);
    expect(store.getProcessed(key(uid))).toMatchObject({
      decision: "SELF_SENT",
      outcome: "SKIPPED",
    });
  });

  it("re-baselines after a UIDVALIDITY change without reprocessing", async () => {
    server.deliver("school", fixture("important-deadline.eml"));
    await poll();
    server.resetUidValidity("school");
    await poll();
    server.deliver("school", eml({ subject: "After reset" }));
    await poll();
    expect(channel.delivered.map((r) => r.original.subject)).toEqual([
      "Assignment 3 due Friday",
      "After reset",
    ]);
  });

  it("keeps polling other accounts when one fails (FR-017)", async () => {
    config = testConfig((c) => {
      const accounts = c.accounts as Array<Record<string, unknown>>;
      accounts.unshift({ ...accounts[0], id: "broken", email: "broken@x.example" });
    });
    server.openFailures.set("broken", new Error("auth failed"));
    await poll();
    server.deliver("school", fixture("important-deadline.eml"));
    await poll();
    expect(channel.delivered).toHaveLength(1);
  });
});
