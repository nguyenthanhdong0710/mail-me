// Migrations are embedded as strings so the built package needs no extra asset copying.
// Append new entries; never edit an applied one.

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE mailbox_state (
        account_id    TEXT NOT NULL,
        mailbox       TEXT NOT NULL,
        uid_validity  INTEGER NOT NULL,
        last_seen_uid INTEGER NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (account_id, mailbox)
      );

      CREATE TABLE processed_messages (
        account_id   TEXT NOT NULL,
        uid_validity INTEGER NOT NULL,
        uid          INTEGER NOT NULL,
        message_id   TEXT,
        sender       TEXT NOT NULL,
        subject      TEXT NOT NULL,
        decision     TEXT NOT NULL,
        category     TEXT,
        confidence   REAL,
        outcome      TEXT NOT NULL,
        tokens_in    INTEGER,
        tokens_out   INTEGER,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (account_id, uid_validity, uid)
      );
      CREATE INDEX processed_messages_message_id ON processed_messages (account_id, message_id);
      CREATE INDEX processed_messages_processed_at ON processed_messages (processed_at);

      CREATE TABLE pending_reports (
        account_id   TEXT NOT NULL,
        uid_validity INTEGER NOT NULL,
        uid          INTEGER NOT NULL,
        report_json  TEXT NOT NULL,
        draft_json   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (account_id, uid_validity, uid)
      );

      CREATE TABLE deliveries (
        account_id      TEXT NOT NULL,
        uid_validity    INTEGER NOT NULL,
        uid             INTEGER NOT NULL,
        channel         TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        parts_sent      INTEGER NOT NULL DEFAULT 0,
        external_id     TEXT,
        last_error      TEXT,
        next_attempt_at TEXT,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, uid_validity, uid, channel)
      );

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Version 1 keyed messages by (account, uid_validity, uid), which collides across two
    // mailboxes of one account that share a UIDVALIDITY. Rebuild the keyed tables with the
    // mailbox in the key. Existing rows predate multi-mailbox support and belong to INBOX.
    version: 2,
    sql: `
      CREATE TABLE processed_messages_v2 (
        account_id   TEXT NOT NULL,
        mailbox      TEXT NOT NULL,
        uid_validity INTEGER NOT NULL,
        uid          INTEGER NOT NULL,
        message_id   TEXT,
        sender       TEXT NOT NULL,
        subject      TEXT NOT NULL,
        decision     TEXT NOT NULL,
        category     TEXT,
        confidence   REAL,
        outcome      TEXT NOT NULL,
        tokens_in    INTEGER,
        tokens_out   INTEGER,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (account_id, mailbox, uid_validity, uid)
      );
      INSERT INTO processed_messages_v2
        SELECT account_id, 'INBOX', uid_validity, uid, message_id, sender, subject, decision,
               category, confidence, outcome, tokens_in, tokens_out, processed_at
        FROM processed_messages;
      DROP TABLE processed_messages;
      ALTER TABLE processed_messages_v2 RENAME TO processed_messages;
      CREATE INDEX processed_messages_message_id ON processed_messages (account_id, message_id);
      CREATE INDEX processed_messages_processed_at ON processed_messages (processed_at);

      CREATE TABLE pending_reports_v2 (
        account_id   TEXT NOT NULL,
        mailbox      TEXT NOT NULL,
        uid_validity INTEGER NOT NULL,
        uid          INTEGER NOT NULL,
        report_json  TEXT NOT NULL,
        draft_json   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (account_id, mailbox, uid_validity, uid)
      );
      INSERT INTO pending_reports_v2
        SELECT account_id, 'INBOX', uid_validity, uid,
               json_set(report_json, '$.key.mailbox', 'INBOX'),
               json_set(draft_json, '$.key.mailbox', 'INBOX'),
               created_at
        FROM pending_reports;
      DROP TABLE pending_reports;
      ALTER TABLE pending_reports_v2 RENAME TO pending_reports;

      CREATE TABLE deliveries_v2 (
        account_id      TEXT NOT NULL,
        mailbox         TEXT NOT NULL,
        uid_validity    INTEGER NOT NULL,
        uid             INTEGER NOT NULL,
        channel         TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        parts_sent      INTEGER NOT NULL DEFAULT 0,
        external_id     TEXT,
        last_error      TEXT,
        next_attempt_at TEXT,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, mailbox, uid_validity, uid, channel)
      );
      INSERT INTO deliveries_v2
        SELECT account_id, 'INBOX', uid_validity, uid, channel, status, attempts, parts_sent,
               external_id, last_error, next_attempt_at, updated_at
        FROM deliveries;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_v2 RENAME TO deliveries;
    `,
  },
];
