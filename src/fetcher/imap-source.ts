import { ImapFlow } from "imapflow";
import type { AccountConfig } from "../config/load.js";
import type { MailSource, MailSourceFactory, RawMessage } from "../domain/ports.js";

/**
 * Read-only IMAP access (research R1). The mailbox is opened with EXAMINE (`readOnly`)
 * and bodies are fetched with BODY.PEEK, so no flags change on the server (FR-013).
 */
export class ImapMailSource implements MailSource {
  private client: ImapFlow | null = null;

  constructor(private readonly account: AccountConfig) {}

  async open(mailbox: string): Promise<{ uidValidity: number; uidNext: number }> {
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
      return { uidValidity: Number(box.uidValidity), uidNext: box.uidNext };
    } catch (err) {
      throw describeImapError(err);
    }
  }

  async *fetchSince(afterUid: number, limit: number): AsyncIterable<RawMessage> {
    const client = this.requireClient();
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
      yield { uid: msg.uid, source: msg.source, internalDate };
      if (++count >= limit) break;
    }
  }

  async firstUidSince(since: Date): Promise<number | null> {
    const uids = await this.requireClient().search({ since }, { uid: true });
    return uids && uids.length > 0 ? Math.min(...uids) : null;
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

export function imapSourceFactory(accounts: AccountConfig[]): MailSourceFactory {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return (accountId) => {
    const account = byId.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    return new ImapMailSource(account);
  };
}
