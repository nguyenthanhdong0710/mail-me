import { ImapFlow } from "imapflow";
import type { AccountConfig } from "../config/load.js";
import type { MailSource, RawMessage } from "../domain/ports.js";

/**
 * Read-only IMAP access (research R1). The mailbox is opened with EXAMINE (`readOnly`)
 * and bodies are fetched with BODY.PEEK, so no flags change on the server (FR-013).
 * The generation is UIDVALIDITY and the cursor is the last UID, both as decimal strings.
 */
export class ImapMailSource implements MailSource {
  private client: ImapFlow | null = null;

  constructor(private readonly account: AccountConfig) {}

  async open(mailbox: string): Promise<{ generation: string; head: string }> {
    if (!this.account.imap) throw new Error(`account ${this.account.id} has no IMAP settings`);
    const { host, port, secure, user, password } = this.account.imap;
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass: password },
      logger: false,
    });
    try {
      await client.connect();
      this.client = client;
      const box = await client.mailboxOpen(mailbox, { readOnly: true });
      return { generation: String(box.uidValidity), head: String(box.uidNext - 1) };
    } catch (err) {
      throw describeImapError(err);
    }
  }

  async *fetchSince(cursor: string, limit: number): AsyncIterable<RawMessage> {
    const client = this.requireClient();
    const afterUid = Number(cursor);
    let count = 0;
    // `N:*` always includes the highest UID even when it is below N, hence the filter.
    for await (const msg of client.fetch(
      `${afterUid + 1}:*`,
      { uid: true, source: true, internalDate: true },
      { uid: true },
    )) {
      if (msg.uid <= afterUid || !msg.source) continue;
      const internalDate =
        msg.internalDate instanceof Date
          ? msg.internalDate
          : new Date(msg.internalDate ?? Date.now());
      yield { id: String(msg.uid), cursor: String(msg.uid), source: msg.source, internalDate };
      if (++count >= limit) break;
    }
  }

  async cursorSince(since: Date): Promise<string | null> {
    const uids = await this.requireClient().search({ since }, { uid: true });
    return uids && uids.length > 0 ? String(Math.min(...uids) - 1) : null;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.logout().catch(() => client.close());
  }

  private requireClient(): ImapFlow {
    if (!this.client) throw new Error("mailbox not open");
    return this.client;
  }
}

/**
 * imapflow reports every rejected command as "Command failed" and keeps the server's reason
 * (e.g. AUTHENTICATIONFAILED / "Invalid credentials") on the error, so surface it in the message.
 */
export function describeImapError(err: unknown): unknown {
  const e = err as { responseText?: string; serverResponseCode?: string };
  if (!(err instanceof Error) || !e.responseText) return err;
  return new Error(`IMAP ${e.serverResponseCode ?? "error"}: ${e.responseText}`, { cause: err });
}
