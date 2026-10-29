import type { MailSource, RawMessage } from "../domain/ports.js";
import type { ApiClient } from "../lib/api-client.js";

const API = "https://graph.microsoft.com/v1.0/me";
/** Stable IDs that survive moves inside the mailbox. */
const HEADERS = { prefer: 'IdType="ImmutableId"' };

interface GraphMessage {
  id: string;
  receivedDateTime: string;
  webLink?: string;
}

/**
 * Read-only Microsoft Graph source (002 research R1/R2), scope `Mail.Read`. The generation is the
 * folder ID and the cursor is the `receivedDateTime` of the last settled message. Messages at
 * the boundary time are listed again and dropped by the processed check.
 */
export class GraphMailSource implements MailSource {
  private folderId: string | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(mailbox: string): Promise<{ generation: string; head: string }> {
    const folder = await this.resolveFolder(mailbox);
    this.folderId = folder;
    return { generation: folder, head: this.now().toISOString() };
  }

  async cursorSince(since: Date): Promise<string | null> {
    return since.toISOString();
  }

  async *fetchSince(cursor: string, limit: number): AsyncIterable<RawMessage> {
    if (!this.folderId) throw new Error("mailbox not open");
    const q = new URLSearchParams({
      $select: "id,receivedDateTime,webLink",
      $filter: `receivedDateTime ge ${new Date(cursor).toISOString()}`,
      $orderby: "receivedDateTime asc",
      $top: "50",
    });
    let url: string | undefined =
      `${API}/mailFolders/${encodeURIComponent(this.folderId)}/messages?${q}`;
    let count = 0;
    while (url) {
      const page: { value?: GraphMessage[]; "@odata.nextLink"?: string } = await this.api.json(
        url,
        { headers: HEADERS },
      );
      for (const m of page.value ?? []) {
        if (count >= limit) return;
        const res = await this.api.request(`${API}/messages/${encodeURIComponent(m.id)}/$value`, {
          headers: HEADERS,
        });
        yield {
          id: m.id,
          cursor: m.receivedDateTime,
          source: Buffer.from(await res.arrayBuffer()),
          internalDate: new Date(m.receivedDateTime),
          ...(m.webLink && { webLink: m.webLink }),
        };
        count++;
      }
      url = page["@odata.nextLink"];
    }
  }

  async close(): Promise<void> {
    this.folderId = null;
  }

  private async resolveFolder(mailbox: string): Promise<string> {
    const wellKnown = mailbox.toUpperCase() === "INBOX" ? "inbox" : null;
    if (wellKnown) {
      const f = await this.api.json<{ id: string }>(`${API}/mailFolders/${wellKnown}`, {
        headers: HEADERS,
      });
      return f.id;
    }
    const q = new URLSearchParams({ $filter: `displayName eq '${mailbox.replace(/'/g, "''")}'` });
    const { value = [] } = await this.api.json<{ value?: Array<{ id: string }> }>(
      `${API}/mailFolders?${q}`,
      { headers: HEADERS },
    );
    if (!value[0]) throw new Error(`Outlook folder "${mailbox}" not found`);
    return value[0].id;
  }
}
