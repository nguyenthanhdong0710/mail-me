import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProcessedRecord, Report } from "../../src/domain/types.js";
import { MIGRATIONS } from "../../src/store/migrations/index.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const key = { accountId: "school", mailbox: "INBOX", uidValidity: "7", uid: "42" };

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
  costUsd: null,
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
      uidValidity: "7",
      cursor: "10",
    });
    store.setMailboxState({
      accountId: "school",
      mailbox: "INBOX",
      uidValidity: "7",
      cursor: "12",
    });
    expect(store.getMailboxState("school", "INBOX")).toMatchObject({ cursor: "12" });
  });

  it("records idempotently and detects by UID and by Message-ID", () => {
    store.recordProcessed(record());
    store.recordProcessed(record({ outcome: "SKIPPED" }));
    expect(store.isProcessed(key, null)).toBe(true);
    // Same message after a UIDVALIDITY reset: new key, same Message-ID.
    expect(store.isProcessed({ ...key, uidValidity: "8", uid: "1" }, "<m1@x>")).toBe(true);
    expect(store.isProcessed({ ...key, uidValidity: "8", uid: "1" }, "<other@x>")).toBe(false);
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
    store.recordProcessed(record({ key: { ...key, uid: "43" }, messageId: null }));
    const removed = store.purgeOlderThan(90, new Date("2026-10-29T08:00:00Z"));
    expect(removed).toBe(1);
    expect(store.isProcessed({ ...key, uid: "43" }, null)).toBe(true);
  });

  it("keeps a stable install id", () => {
    const id = store.getInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.getInstallId()).toBe(id);
  });
});

describe("migration 002 (mailbox in the message key)", () => {
  it("moves version-1 rows to INBOX and keeps pending reports usable", () => {
    const dir = mkdtempSync(join(tmpdir(), "mail-me-"));
    const path = join(dir, "v1.db");
    const v1 = new Database(path);
    v1.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    v1.exec(MIGRATIONS[0]!.sql);
    v1.prepare("INSERT INTO schema_migrations VALUES (1, '2026-10-01')").run();
    v1.prepare(
      `INSERT INTO processed_messages (account_id, uid_validity, uid, message_id, sender, subject,
         decision, outcome, processed_at) VALUES ('school', 7, 1, '<a@x>', 's', 'old', 'LLM', 'SKIPPED', '2026-10-01')`,
    ).run();
    const oldKey = { accountId: "school", uidValidity: "7", uid: "2" };
    v1.prepare("INSERT INTO pending_reports VALUES ('school', 7, 2, ?, ?, '2026-10-01')").run(
      JSON.stringify({ key: oldKey }),
      JSON.stringify({ key: oldKey }),
    );
    v1.prepare(
      "INSERT INTO deliveries (account_id, uid_validity, uid, channel, status, updated_at) VALUES ('school', 7, 2, 'email', 'PENDING', '2026-10-01')",
    ).run();
    v1.close();

    const store = new SqliteStore(path);
    expect(
      store.isProcessed(
        { accountId: "school", mailbox: "INBOX", uidValidity: "7", uid: "1" },
        null,
      ),
    ).toBe(true);
    expect(
      store.isProcessed({ accountId: "school", mailbox: "Work", uidValidity: "7", uid: "1" }, null),
    ).toBe(false);
    const [pending] = store.listPendingReports();
    expect(pending!.report.key).toEqual({ ...oldKey, mailbox: "INBOX" });
    expect(pending!.deliveries).toMatchObject([
      { channel: "email", status: "PENDING", key: { mailbox: "INBOX" } },
    ]);
    store.close();
    rmSync(dir, { recursive: true });
  });
});
