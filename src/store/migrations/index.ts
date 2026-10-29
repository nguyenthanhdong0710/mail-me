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
];
