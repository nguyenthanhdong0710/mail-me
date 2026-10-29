import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { MIGRATIONS } from "../../src/store/migrations/index.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer, sampleReport } from "../fakes/index.js";
import { eml } from "../fixtures/load.js";

const logger = createLogger({ level: "silent" });

/** A database exactly as feature 001 left it: migrations 1 and 2, numeric keys. */
function v2Database(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.filter((x) => x.version <= 2)) {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, '2026-10-01')").run(m.version);
  }
  db.prepare("INSERT INTO mailbox_state VALUES ('school', 'INBOX', 1, 3, '2026-10-01')").run();
  db.prepare(
    `INSERT INTO processed_messages (account_id, mailbox, uid_validity, uid, message_id, sender, subject,
       decision, outcome, processed_at) VALUES ('school', 'INBOX', 1, 2, '<a@x>', 's', 'old', 'LLM', 'SKIPPED', '2026-10-01')`,
  ).run();
  // 001 stored numeric keys inside the JSON as well.
  const report = {
    ...sampleReport(),
    key: { accountId: "school", mailbox: "INBOX", uidValidity: 1, uid: 3 },
  };
  db.prepare(
    "INSERT INTO pending_reports VALUES ('school', 'INBOX', 1, 3, ?, ?, '2026-10-01')",
  ).run(
    JSON.stringify(report),
    JSON.stringify({
      key: report.key,
      messageId: "<orig@university.edu>",
      sender: "prof@university.edu",
      subject: "Assignment 3",
      decision: "LLM",
      category: "IMPORTANT",
      confidence: 0.9,
      tokensIn: 1,
      tokensOut: 1,
    }),
  );
  db.prepare(
    "INSERT INTO deliveries (account_id, mailbox, uid_validity, uid, channel, status, updated_at) VALUES ('school', 'INBOX', 1, 3, 'email', 'PENDING', '2026-10-01')",
  ).run();
  db.close();
}

describe("migration 3 (text keys and cursors)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the cursor, delivers the old pending report and replays nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "mail-me-"));
    const path = join(dir, "v2.db");
    v2Database(path);

    const store = new SqliteStore(path);
    expect(store.getMailboxState("school", "INBOX")).toEqual({
      accountId: "school",
      mailbox: "INBOX",
      uidValidity: "1",
      cursor: "3",
    });
    expect(
      store.isProcessed(
        { accountId: "school", mailbox: "INBOX", uidValidity: "1", uid: "2" },
        null,
      ),
    ).toBe(true);
    const [pending] = store.listPendingReports();
    expect(pending!.report.key).toEqual({
      accountId: "school",
      mailbox: "INBOX",
      uidValidity: "1",
      uid: "3",
    });

    const server = new FakeMailServer();
    for (let i = 1; i <= 3; i++) server.deliver("school", eml({ subject: `old ${i}` }));
    server.deliver("school", eml({ subject: "new mail" }));
    const channel = new FakeChannel("email");
    const llm = new FakeLlm();
    const config = testConfig();
    const pipeline = new Pipeline({
      config,
      store,
      llm,
      channels: new Map([["email", channel]]),
      sources: server.factory(),
      clock: new FakeClock(),
      logger,
      retry: { attempts: 1, sleep: async () => {} },
    });
    await pipeline.pollAccount(config.accounts[0]!);

    expect(channel.delivered.map((r) => r.original.subject)).toEqual(["Assignment 3", "new mail"]);
    expect(store.listPendingReports()).toEqual([]);
    expect(store.getMailboxState("school", "INBOX")?.cursor).toBe("4");
    store.close();
  });
});
