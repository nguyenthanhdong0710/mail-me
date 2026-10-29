import { beforeEach, describe, expect, it } from "vitest";
import type { ProcessedRecord, Report } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const key = { accountId: "school", uidValidity: 7, uid: 42 };

const record = (over: Partial<ProcessedRecord> = {}): ProcessedRecord => ({
  key,
  messageId: "<m1@x>",
  sender: "a@b.c",
  subject: "Hello",
  decision: "LLM",
  category: "IMPORTANT",
  confidence: 0.9,
  outcome: "FORWARDED",
  tokensIn: 10,
  tokensOut: 5,
  processedAt: "2026-10-29T08:00:00.000Z",
  ...over,
});

const report: Report = {
  key,
  source: { accountId: "school", label: "School" },
  original: {
    messageId: "<m1@x>",
    from: { address: "a@b.c" },
    subject: "Hello",
    receivedAt: "2026-10-29T08:00:00.000Z",
  },
  kind: "SUMMARY",
  analysis: null,
  excerpt: "Hello",
  truncated: false,
  urgent: false,
  actionNeeded: false,
};

const { outcome, processedAt, ...draftRecord } = record();
void outcome;
void processedAt;

describe("SqliteStore", () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore(":memory:");
  });

  it("stores mailbox state", () => {
    expect(store.getMailboxState("school", "INBOX")).toBeNull();
    store.setMailboxState({
      accountId: "school",
      mailbox: "INBOX",
      uidValidity: 7,
      lastSeenUid: 10,
    });
    store.setMailboxState({
      accountId: "school",
      mailbox: "INBOX",
      uidValidity: 7,
      lastSeenUid: 12,
    });
    expect(store.getMailboxState("school", "INBOX")).toMatchObject({ lastSeenUid: 12 });
  });

  it("records idempotently and detects by UID and by Message-ID", () => {
    store.recordProcessed(record());
    store.recordProcessed(record({ outcome: "SKIPPED" }));
    expect(store.isProcessed(key, null)).toBe(true);
    // Same message after a UIDVALIDITY reset: new key, same Message-ID.
    expect(store.isProcessed({ ...key, uidValidity: 8, uid: 1 }, "<m1@x>")).toBe(true);
    expect(store.isProcessed({ ...key, uidValidity: 8, uid: 1 }, "<other@x>")).toBe(false);
    expect(store.isProcessed({ ...key, accountId: "work" }, "<m1@x>")).toBe(false);
  });

  it("tracks the pending report lifecycle", () => {
    store.savePendingReport(report, draftRecord, ["email", "telegram"]);
    expect(store.hasPendingReport(key)).toBe(true);
    const [pending] = store.listPendingReports("school");
    expect(pending?.report).toEqual(report);
    expect(pending?.draft).toEqual(draftRecord);
    expect(pending?.deliveries.map((d) => [d.channel, d.status])).toEqual([
      ["email", "PENDING"],
      ["telegram", "PENDING"],
    ]);

    store.updateDelivery({
      ...pending!.deliveries[0]!,
      status: "DELIVERED",
      attempts: 1,
      externalId: "<sent@x>",
    });
    expect(store.listPendingReports()[0]?.deliveries[0]).toMatchObject({
      status: "DELIVERED",
      externalId: "<sent@x>",
    });
    expect(store.listPendingReports("work")).toEqual([]);
  });

  it("completes a report atomically", () => {
    store.savePendingReport(report, draftRecord, ["email"]);
    store.completeReport(record());
    expect(store.hasPendingReport(key)).toBe(false);
    expect(store.isProcessed(key, null)).toBe(true);
  });

  it("purges old records only", () => {
    store.recordProcessed(record({ processedAt: "2026-01-01T00:00:00.000Z" }));
    store.recordProcessed(record({ key: { ...key, uid: 43 }, messageId: null }));
    const removed = store.purgeOlderThan(90, new Date("2026-10-29T08:00:00Z"));
    expect(removed).toBe(1);
    expect(store.isProcessed({ ...key, uid: 43 }, null)).toBe(true);
  });

  it("keeps a stable install id", () => {
    const id = store.getInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.getInstallId()).toBe(id);
  });
});
