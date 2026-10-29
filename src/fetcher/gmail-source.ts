import type { MailSource, RawMessage } from "../domain/ports.js";
import { ApiError, type ApiClient } from "../lib/api-client.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface HistoryMessage {
  id: string;
  labelIds?: string[];
}

interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: HistoryMessage }>;
  labelsAdded?: Array<{ message: HistoryMessage; labelIds?: string[] }>;
}

interface HistoryPage {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

type Cursor = { mode: "h"; historyId: string; ms: number } | { mode: "t"; ms: number };

export function parseGmailCursor(cursor: string): Cursor {
  const h = /^h:(\d+)@(\d+)$/.exec(cursor);
  if (h) return { mode: "h", historyId: h[1]!, ms: Number(h[2]) };
  const t = /^t:(\d+)$/.exec(cursor);
  if (t) return { mode: "t", ms: Number(t[1]) };
  throw new Error(`not a Gmail cursor: ${cursor}`);
}

/**
 * Read-only Gmail API source (002 research R1/R2), scope `gmail.readonly`. Cursors:
 * `h:<historyId>@<ms>` follows `users.history.list`; `t:<ms>` lists by time and is used for the
 * look-back window and when the history ID has expired (HTTP 404), then switches back to `h:`
 * at the head captured in open().
 */
export class GmailApiSource implements MailSource {
  private labelId: string | null = null;
  private head: { historyId: string } | null = null;
  private settled: string | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly now: () => number = Date.now,
  ) {}

  async open(mailbox: string): Promise<{ generation: string; head: string }> {
    this.labelId = await this.resolveLabel(mailbox);
    const profile = await this.api.json<{ historyId: string }>(`${API}/profile`);
    this.head = { historyId: profile.historyId };
    return { generation: `gmail:${this.labelId}`, head: `h:${profile.historyId}@${this.now()}` };
  }

  async cursorSince(since: Date): Promise<string | null> {
    return `t:${since.getTime()}`;
  }

  settledCursor(): string | null {
    return this.settled;
  }

  async *fetchSince(cursor: string, limit: number): AsyncIterable<RawMessage> {
    const label = this.requireLabel();
    this.settled = null;
    let parsed = parseGmailCursor(cursor);
    if (parsed.mode === "h") {
      try {
        yield* this.fromHistory(label, parsed.historyId, parsed.ms, limit);
        return;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        // History IDs expire after about a week: catch up by time instead (FR-104).
        parsed = { mode: "t", ms: parsed.ms };
      }
    }
    yield* this.fromTime(label, parsed.ms, limit);
  }

  async close(): Promise<void> {
    this.labelId = null;
  }

  private async *fromHistory(
    label: string,
    startHistoryId: string,
    lastMs: number,
    limit: number,
  ): AsyncIterable<RawMessage> {
    const seen = new Set<string>();
    let previous = `h:${startHistoryId}@${lastMs}`;
    let latest = startHistoryId;
    let count = 0;
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ startHistoryId, labelId: label, maxResults: "100" });
      q.append("historyTypes", "messageAdded");
      q.append("historyTypes", "labelAdded");
      if (pageToken) q.set("pageToken", pageToken);
      const page = await this.api.json<HistoryPage>(`${API}/history?${q}`);
      if (page.historyId) latest = page.historyId;
      for (const record of page.history ?? []) {
        const ids = [
          ...(record.messagesAdded ?? [])
            .filter((m) => m.message.labelIds?.includes(label) ?? true)
            .map((m) => m.message.id),
          ...(record.labelsAdded ?? [])
            .filter((m) => m.labelIds?.includes(label))
            .map((m) => m.message.id),
        ].filter((id) => !seen.has(id) && (seen.add(id), true));
        for (const [i, id] of ids.entries()) {
          if (count >= limit) return;
          const msg = await this.getRaw(id);
          // Only the last message of a record may move the cursor past the record: history
          // listing resumes after startHistoryId, so an earlier one would skip its siblings.
          const cursor =
            i === ids.length - 1 ? `h:${record.id}@${msg.internalDate.getTime()}` : previous;
          yield { ...msg, cursor };
          count++;
        }
        if (ids.length > 0) previous = `h:${record.id}@${lastMs}`;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    this.settled = `h:${latest}@${this.now()}`;
  }

  private async *fromTime(
    label: string,
    sinceMs: number,
    limit: number,
  ): AsyncIterable<RawMessage> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        labelIds: label,
        q: `after:${Math.max(0, Math.floor(sinceMs / 1000) - 1)}`,
        maxResults: "500",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await this.api.json<{
        messages?: Array<{ id: string }>;
        nextPageToken?: string;
      }>(`${API}/messages?${q}`);
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken);

    // The list is newest first and its order is not guaranteed: sort by received time.
    const dated = await Promise.all(
      ids.map(async (id) => {
        const m = await this.api.json<{ internalDate: string }>(
          `${API}/messages/${encodeURIComponent(id)}?format=minimal`,
        );
        return { id, ms: Number(m.internalDate) };
      }),
    );
    dated.sort((a, b) => a.ms - b.ms || a.id.localeCompare(b.id));

    let count = 0;
    for (const { id, ms } of dated) {
      if (ms < sinceMs) continue;
      if (count >= limit) return;
      const msg = await this.getRaw(id);
      yield { ...msg, cursor: `t:${ms}` };
      count++;
    }
    // Caught up: continue from the history head captured when the mailbox was opened.
    if (this.head) this.settled = `h:${this.head.historyId}@${this.now()}`;
  }

  private async getRaw(id: string): Promise<Omit<RawMessage, "cursor">> {
    const m = await this.api.json<{ id: string; raw: string; internalDate: string }>(
      `${API}/messages/${encodeURIComponent(id)}?format=raw`,
    );
    return {
      id: m.id,
      source: Buffer.from(m.raw, "base64url"),
      internalDate: new Date(Number(m.internalDate)),
    };
  }

  private async resolveLabel(mailbox: string): Promise<string> {
    if (mailbox.toUpperCase() === "INBOX") return "INBOX";
    const { labels = [] } = await this.api.json<{ labels?: Array<{ id: string; name: string }> }>(
      `${API}/labels`,
    );
    const match = labels.find(
      (l) => l.id === mailbox || l.name.toLowerCase() === mailbox.toLowerCase(),
    );
    if (!match) throw new Error(`Gmail label "${mailbox}" not found`);
    return match.id;
  }

  private requireLabel(): string {
    if (!this.labelId) throw new Error("mailbox not open");
    return this.labelId;
  }
}
