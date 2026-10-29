import { FakeApi, type RecordedCall } from "../../fakes/http.js";
import { eml } from "../load.js";

/** A message as the Gmail API stores it. */
export interface GmailFixtureMessage {
  id: string;
  internalDate: number;
  labelIds: string[];
  subject: string;
}

/**
 * A scripted Gmail mailbox for the API: profile, labels, history (with optional expiry) and
 * messages in `raw` and `minimal` formats, recorded from the real API's response shapes.
 */
export class FakeGmail {
  readonly api = new FakeApi();
  historyId = 1000;
  /** History records: id → message IDs added to INBOX (as messageAdded) or labelled later. */
  readonly records: Array<{ id: number; added?: string[]; labelled?: string[] }> = [];
  readonly messages = new Map<string, GmailFixtureMessage>();
  /** startHistoryId values older than this answer 404 (expired history). */
  expiredBelow = 0;

  constructor() {
    const base = /gmail\.googleapis\.com\/gmail\/v1\/users\/me/;
    this.api
      .on("GET", new RegExp(`${base.source}/profile$`), () => ({
        json: { emailAddress: "student@university.edu", historyId: String(this.historyId) },
      }))
      .on("GET", new RegExp(`${base.source}/labels$`), {
        json: {
          labels: [
            { id: "INBOX", name: "INBOX" },
            { id: "Label_7", name: "School" },
          ],
        },
      })
      .on("GET", new RegExp(`${base.source}/history$`), (c) => this.history(c))
      .on("GET", new RegExp(`${base.source}/messages$`), (c) => this.list(c))
      .on("GET", new RegExp(`${base.source}/messages/[^/]+$`), (c) => this.get(c));
  }

  add(id: string, internalDate: number, opts: { labelled?: boolean } = {}): void {
    this.messages.set(id, { id, internalDate, labelIds: ["INBOX"], subject: `msg ${id}` });
    this.historyId += 10;
    this.records.push({
      id: this.historyId,
      ...(opts.labelled ? { labelled: [id] } : { added: [id] }),
    });
  }

  private history(c: RecordedCall) {
    const start = Number(c.url.searchParams.get("startHistoryId"));
    if (start < this.expiredBelow) {
      return {
        status: 404,
        json: { error: { code: 404, message: "Requested entity was not found." } },
      };
    }
    const records = this.records.filter((r) => r.id > start);
    const pageSize = 2;
    const offset = Number(c.url.searchParams.get("pageToken") ?? 0);
    const page = records.slice(offset, offset + pageSize);
    const msg = (id: string) => ({ id, threadId: id, labelIds: this.messages.get(id)!.labelIds });
    return {
      json: {
        history: page.map((r) => ({
          id: String(r.id),
          ...(r.added && { messagesAdded: r.added.map((id) => ({ message: msg(id) })) }),
          ...(r.labelled && {
            labelsAdded: r.labelled.map((id) => ({ message: msg(id), labelIds: ["INBOX"] })),
          }),
        })),
        historyId: String(this.historyId),
        ...(offset + pageSize < records.length && { nextPageToken: String(offset + pageSize) }),
      },
    };
  }

  private list(c: RecordedCall) {
    const after = Number(/after:(\d+)/.exec(c.url.searchParams.get("q") ?? "")?.[1] ?? 0);
    const ids = [...this.messages.values()]
      .filter((m) => m.internalDate / 1000 > after)
      .sort((a, b) => b.internalDate - a.internalDate)
      .map((m) => ({ id: m.id, threadId: m.id }));
    return { json: ids.length ? { messages: ids } : {} };
  }

  private get(c: RecordedCall) {
    const id = decodeURIComponent(c.url.pathname.split("/").at(-1)!);
    const m = this.messages.get(id);
    if (!m) return { status: 404, json: {} };
    const base = {
      id: m.id,
      threadId: m.id,
      labelIds: m.labelIds,
      internalDate: String(m.internalDate),
    };
    if (c.url.searchParams.get("format") === "minimal") return { json: base };
    const raw = Buffer.from(
      eml({ subject: m.subject, messageId: `<${m.id}@gmail.test>` }),
    ).toString("base64url");
    return { json: { ...base, raw } };
  }
}
