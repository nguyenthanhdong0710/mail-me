import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Store } from "../domain/ports.js";
import type {
  ChannelName,
  DeliveryRow,
  DeliveryStatus,
  DraftRecord,
  MailboxState,
  MessageKey,
  PendingReport,
  ProcessedRecord,
  Report,
} from "../domain/types.js";
import { MIGRATIONS } from "./migrations/index.js";

interface DeliveryDbRow {
  account_id: string;
  mailbox: string;
  uid_validity: string;
  uid: string;
  channel: string;
  status: string;
  attempts: number;
  parts_sent: number;
  external_id: string | null;
  last_error: string | null;
  next_attempt_at: string | null;
}

const keyParams = (k: MessageKey) => ({
  account_id: k.accountId,
  mailbox: k.mailbox,
  uid_validity: k.uidValidity,
  uid: k.uid,
});

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  /** `path` may be ":memory:" for tests. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      this.db
        .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
        .all()
        .map((r) => r.version),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(m.version, new Date().toISOString());
      })();
    }
  }

  getMailboxState(accountId: string, mailbox: string): MailboxState | null {
    const row = this.db
      .prepare<[string, string], { uid_validity: string; cursor: string }>(
        "SELECT uid_validity, cursor FROM mailbox_state WHERE account_id = ? AND mailbox = ?",
      )
      .get(accountId, mailbox);
    return row ? { accountId, mailbox, uidValidity: row.uid_validity, cursor: row.cursor } : null;
  }

  setMailboxState(s: MailboxState): void {
    this.db
      .prepare(
        `INSERT INTO mailbox_state (account_id, mailbox, uid_validity, cursor, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account_id, mailbox) DO UPDATE SET
           uid_validity = excluded.uid_validity,
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
      )
      .run(s.accountId, s.mailbox, s.uidValidity, s.cursor, new Date().toISOString());
  }

  isProcessed(key: MessageKey, messageId: string | null): boolean {
    const byUid = this.db
      .prepare(
        "SELECT 1 FROM processed_messages WHERE account_id = @account_id AND mailbox = @mailbox AND uid_validity = @uid_validity AND uid = @uid",
      )
      .get(keyParams(key));
    if (byUid) return true;
    if (!messageId) return false;
    // Secondary dedup across UIDVALIDITY resets (research R2).
    return !!this.db
      .prepare("SELECT 1 FROM processed_messages WHERE account_id = ? AND message_id = ?")
      .get(key.accountId, messageId);
  }

  /** Outcome lookup for diagnostics and tests. */
  getProcessed(key: MessageKey): {
    decision: string;
    category: string | null;
    outcome: string;
    cost_usd: number | null;
  } | null {
    return (
      this.db
        .prepare<
          Record<string, unknown>,
          { decision: string; category: string | null; outcome: string; cost_usd: number | null }
        >(
          `SELECT decision, category, outcome, cost_usd FROM processed_messages
           WHERE account_id = @account_id AND mailbox = @mailbox AND uid_validity = @uid_validity AND uid = @uid`,
        )
        .get(keyParams(key)) ?? null
    );
  }

  hasPendingReport(key: MessageKey): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM pending_reports WHERE account_id = @account_id AND mailbox = @mailbox AND uid_validity = @uid_validity AND uid = @uid",
      )
      .get(keyParams(key));
  }

  recordProcessed(r: ProcessedRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_messages
           (account_id, mailbox, uid_validity, uid, message_id, sender, subject, decision, category,
            confidence, outcome, tokens_in, tokens_out, cost_usd, processed_at)
         VALUES (@account_id, @mailbox, @uid_validity, @uid, @message_id, @sender, @subject, @decision,
                 @category, @confidence, @outcome, @tokens_in, @tokens_out, @cost_usd, @processed_at)`,
      )
      .run({
        ...keyParams(r.key),
        message_id: r.messageId,
        sender: r.sender,
        subject: r.subject,
        decision: r.decision,
        category: r.category,
        confidence: r.confidence,
        outcome: r.outcome,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
        cost_usd: r.costUsd ?? null,
        processed_at: r.processedAt,
      });
  }

  purgeOlderThan(days: number, now: Date): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return this.db.transaction(() => {
      const res = this.db
        .prepare("DELETE FROM processed_messages WHERE processed_at < ?")
        .run(cutoff);
      // Delivery rows of completed reports go with them; pending ones are kept.
      this.db
        .prepare(
          `DELETE FROM deliveries WHERE updated_at < ? AND NOT EXISTS (
             SELECT 1 FROM pending_reports p WHERE p.account_id = deliveries.account_id
               AND p.mailbox = deliveries.mailbox AND p.uid_validity = deliveries.uid_validity AND p.uid = deliveries.uid)`,
        )
        .run(cutoff);
      return res.changes;
    })();
  }

  savePendingReport(report: Report, draft: DraftRecord, channels: ChannelName[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pending_reports (account_id, mailbox, uid_validity, uid, report_json, draft_json, created_at)
           VALUES (@account_id, @mailbox, @uid_validity, @uid, @report_json, @draft_json, @created_at)`,
        )
        .run({
          ...keyParams(report.key),
          report_json: JSON.stringify(report),
          draft_json: JSON.stringify(draft),
          created_at: now,
        });
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO deliveries (account_id, mailbox, uid_validity, uid, channel, status, updated_at)
         VALUES (@account_id, @mailbox, @uid_validity, @uid, @channel, 'PENDING', @updated_at)`,
      );
      for (const channel of channels) {
        insert.run({ ...keyParams(report.key), channel, updated_at: now });
      }
    })();
  }

  listPendingReports(accountId?: string): PendingReport[] {
    const reports = this.db
      .prepare<
        [],
        {
          account_id: string;
          mailbox: string;
          uid_validity: string;
          uid: string;
          report_json: string;
          draft_json: string;
        }
      >(
        `SELECT account_id, mailbox, uid_validity, uid, report_json, draft_json FROM pending_reports
         ORDER BY created_at, uid`,
      )
      .all()
      .filter((r) => accountId === undefined || r.account_id === accountId);
    const deliveriesFor = this.db.prepare<[string, string, string, string], DeliveryDbRow>(
      "SELECT * FROM deliveries WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ? ORDER BY channel",
    );
    return reports.map((r) => {
      // Rows written before migration 3 hold numeric keys in their JSON; the columns are the
      // source of truth (data-model.md "Migration 3").
      const key: MessageKey = {
        accountId: r.account_id,
        mailbox: r.mailbox,
        uidValidity: r.uid_validity,
        uid: r.uid,
      };
      return {
        report: { ...(JSON.parse(r.report_json) as Report), key },
        draft: { ...(JSON.parse(r.draft_json) as DraftRecord), key },
        deliveries: deliveriesFor
          .all(r.account_id, r.mailbox, r.uid_validity, r.uid)
          .map(toDeliveryRow),
      };
    });
  }

  updateDelivery(row: DeliveryRow): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = @status, attempts = @attempts, parts_sent = @parts_sent,
           external_id = @external_id, last_error = @last_error, next_attempt_at = @next_attempt_at,
           updated_at = @updated_at
         WHERE account_id = @account_id AND mailbox = @mailbox AND uid_validity = @uid_validity AND uid = @uid AND channel = @channel`,
      )
      .run({
        ...keyParams(row.key),
        channel: row.channel,
        status: row.status,
        attempts: row.attempts,
        parts_sent: row.partsSent,
        external_id: row.externalId,
        last_error: row.lastError,
        next_attempt_at: row.nextAttemptAt,
        updated_at: new Date().toISOString(),
      });
  }

  completeReport(record: ProcessedRecord): void {
    this.db.transaction(() => {
      this.recordProcessed(record);
      this.db
        .prepare(
          "DELETE FROM pending_reports WHERE account_id = @account_id AND mailbox = @mailbox AND uid_validity = @uid_validity AND uid = @uid",
        )
        .run(keyParams(record.key));
    })();
  }

  getInstallId(): string {
    const row = this.db
      .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'install_id'")
      .get();
    if (row) return row.value;
    const id = randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('install_id', ?)").run(id);
    return this.getInstallId();
  }

  close(): void {
    this.db.close();
  }
}

function toDeliveryRow(r: DeliveryDbRow): DeliveryRow {
  return {
    key: { accountId: r.account_id, mailbox: r.mailbox, uidValidity: r.uid_validity, uid: r.uid },
    channel: r.channel as ChannelName,
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    partsSent: r.parts_sent,
    externalId: r.external_id,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at,
  };
}
