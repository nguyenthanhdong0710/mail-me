import { FakeApi, type RecordedCall } from "../../fakes/http.js";
import { eml } from "../load.js";

export interface GraphFixtureMessage {
  id: string;
  receivedDateTime: string;
  subject: string;
}

/**
 * A scripted Outlook mailbox behind Microsoft Graph: well-known and named folders, a message list
 * honoring `$filter=receivedDateTime ge …`, `$orderby`, `$top` paging, and `$value` MIME.
 */
export class FakeGraph {
  readonly api = new FakeApi();
  readonly messages: GraphFixtureMessage[] = [];

  constructor() {
    const me = /graph\.microsoft\.com\/v1\.0\/me/;
    this.api
      .on("GET", new RegExp(`${me.source}/mailFolders/inbox$`), { json: { id: "AAMkInbox==" } })
      .on("GET", new RegExp(`${me.source}/mailFolders$`), (c) => ({
        json: {
          value: (c.url.searchParams.get("$filter") ?? "").includes("'Projects'")
            ? [{ id: "AAMkProjects==" }]
            : [],
        },
      }))
      .on("GET", new RegExp(`${me.source}/mailFolders/[^/]+/messages$`), (c) => this.list(c))
      .on("GET", new RegExp(`${me.source}/messages/[^/]+/\\$value$`), (c) => this.value(c));
  }

  add(id: string, receivedDateTime: string): void {
    this.messages.push({ id, receivedDateTime, subject: `msg ${id}` });
  }

  private list(c: RecordedCall) {
    const filter = c.url.searchParams.get("$filter") ?? "";
    const since = /receivedDateTime ge (\S+)/.exec(filter)?.[1];
    const top = Number(c.url.searchParams.get("$top") ?? 10);
    const skip = Number(c.url.searchParams.get("$skip") ?? 0);
    const all = this.messages
      .filter((m) => !since || m.receivedDateTime >= since)
      .sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
    const page = all.slice(skip, skip + top);
    const next = new URL(c.url);
    next.searchParams.set("$skip", String(skip + top));
    return {
      json: {
        value: page.map((m) => ({
          id: m.id,
          receivedDateTime: m.receivedDateTime,
          webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(m.id)}&exvsurl=1&viewmodel=ReadMessageItem`,
        })),
        ...(skip + top < all.length && { "@odata.nextLink": next.toString() }),
      },
    };
  }

  private value(c: RecordedCall) {
    const id = decodeURIComponent(c.url.pathname.split("/").at(-2)!);
    const m = this.messages.find((x) => x.id === id);
    if (!m) return { status: 404, json: {} };
    return {
      text: eml({ subject: m.subject, messageId: `<${m.id}@outlook.test>` }),
      headers: { "content-type": "message/rfc822" },
    };
  }
}
