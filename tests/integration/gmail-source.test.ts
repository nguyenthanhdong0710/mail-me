import { describe, expect, it } from "vitest";
import { GrantRevokedError, type RawMessage, type TokenProvider } from "../../src/domain/ports.js";
import { GmailApiSource } from "../../src/fetcher/gmail-source.js";
import { ApiClient } from "../../src/lib/api-client.js";
import { FakeGmail } from "../fixtures/http/gmail.js";

const tokens: TokenProvider = { accessToken: async () => "ya29.test", invalidate: () => {} };
const NOW = 1_800_000_000_000;

function source(gmail: FakeGmail) {
  const api = new ApiClient(
    gmail.api.fetch,
    tokens,
    { name: "school.read", fixCommand: "mail-me auth school" },
    "gmail",
  );
  return new GmailApiSource(api, () => NOW);
}

async function drain(it: AsyncIterable<RawMessage>): Promise<RawMessage[]> {
  const out: RawMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

describe("GmailApiSource (gmail.readonly)", () => {
  it("opens at the current history ID and yields new mail oldest first", async () => {
    const gmail = new FakeGmail();
    const src = source(gmail);
    const { generation, head } = await src.open("INBOX");
    expect(generation).toBe("gmail:INBOX");
    expect(head).toBe(`h:1000@${NOW}`);

    gmail.add("aa01", 1_799_000_000_000);
    gmail.add("aa02", 1_799_000_100_000);
    gmail.add("aa03", 1_799_000_200_000, { labelled: true }); // moved into the inbox
    const msgs = await drain(src.fetchSince(head, 50));
    expect(msgs.map((m) => m.id)).toEqual(["aa01", "aa02", "aa03"]);
    expect(msgs.map((m) => m.cursor)).toEqual([
      "h:1010@1799000000000",
      "h:1020@1799000100000",
      "h:1030@1799000200000",
    ]);
    expect(msgs[0]!.source.toString()).toContain("Subject: msg aa01");
    expect(src.settledCursor()).toBe(`h:1030@${NOW}`);
  });

  it("stops at the limit without claiming a settled cursor", async () => {
    const gmail = new FakeGmail();
    const src = source(gmail);
    const { head } = await src.open("INBOX");
    for (let i = 1; i <= 3; i++) gmail.add(`b${i}`, 1_799_000_000_000 + i);
    expect((await drain(src.fetchSince(head, 2))).map((m) => m.id)).toEqual(["b1", "b2"]);
    expect(src.settledCursor()).toBeNull();
  });

  it("falls back to time-based listing when history has expired, then returns to history", async () => {
    const gmail = new FakeGmail();
    gmail.add("old1", 1_799_000_000_000);
    gmail.add("new1", 1_799_500_000_000);
    gmail.add("new2", 1_799_600_000_000);
    gmail.expiredBelow = 5000;
    const src = source(gmail);
    await src.open("INBOX");

    const msgs = await drain(src.fetchSince("h:900@1799400000000", 50));
    expect(msgs.map((m) => m.id)).toEqual(["new1", "new2"]);
    expect(msgs.map((m) => m.cursor)).toEqual(["t:1799500000000", "t:1799600000000"]);
    expect(src.settledCursor()).toBe(`h:${gmail.historyId}@${NOW}`);
  });

  it("uses time mode for the look-back window", async () => {
    const gmail = new FakeGmail();
    gmail.add("x1", 1_799_000_000_000);
    gmail.add("x2", 1_799_900_000_000);
    const src = source(gmail);
    await src.open("INBOX");
    const cursor = await src.cursorSince(new Date(1_799_800_000_000));
    expect(cursor).toBe("t:1799800000000");
    expect((await drain(src.fetchSince(cursor!, 50))).map((m) => m.id)).toEqual(["x2"]);
  });

  it("resolves label names", async () => {
    const gmail = new FakeGmail();
    expect((await source(gmail).open("school")).generation).toBe("gmail:Label_7");
    await expect(source(gmail).open("Nope")).rejects.toThrow('Gmail label "Nope" not found');
  });

  it("reports a revoked grant", async () => {
    const gmail = new FakeGmail();
    gmail.api.once("GET", /\/profile$/, { status: 401, json: {} });
    gmail.api.once("GET", /\/profile$/, { status: 401, json: {} });
    await expect(source(gmail).open("INBOX")).rejects.toBeInstanceOf(GrantRevokedError);
  });

  it("never sends anything but GET requests (FR-109)", async () => {
    const gmail = new FakeGmail();
    const src = source(gmail);
    const { head } = await src.open("INBOX");
    gmail.add("c1", 1_799_000_000_000);
    await drain(src.fetchSince(head, 50));
    await drain(src.fetchSince("t:0", 50));
    expect(new Set(gmail.api.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });
});
