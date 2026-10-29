import { describe, expect, it } from "vitest";
import type { RawMessage, TokenProvider } from "../../src/domain/ports.js";
import { GraphMailSource } from "../../src/fetcher/graph-source.js";
import { ApiClient, ApiError } from "../../src/lib/api-client.js";
import { FakeGraph } from "../fixtures/http/graph.js";

const tokens: TokenProvider = { accessToken: async () => "eyJ.test", invalidate: () => {} };
const NOW = new Date("2026-11-03T10:00:00Z");

function source(graph: FakeGraph) {
  const api = new ApiClient(
    graph.api.fetch,
    tokens,
    { name: "work.read", fixCommand: "mail-me auth work" },
    "graph",
  );
  return new GraphMailSource(api, () => NOW);
}

async function drain(it: AsyncIterable<RawMessage>): Promise<RawMessage[]> {
  const out: RawMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

describe("GraphMailSource (Mail.Read)", () => {
  it("maps INBOX to the well-known folder and starts at now", async () => {
    const graph = new FakeGraph();
    expect(await source(graph).open("INBOX")).toEqual({
      generation: "AAMkInbox==",
      head: "2026-11-03T10:00:00.000Z",
    });
    expect((await source(graph).open("Projects")).generation).toBe("AAMkProjects==");
    await expect(source(graph).open("Nope")).rejects.toThrow('Outlook folder "Nope" not found');
  });

  it("lists by received time across pages and yields MIME, cursor and webLink", async () => {
    const graph = new FakeGraph();
    for (let i = 0; i < 60; i++) {
      graph.add(
        `id-${String(i).padStart(2, "0")}`,
        `2026-11-03T10:${String(i).padStart(2, "0")}:00Z`,
      );
    }
    const src = source(graph);
    const { head } = await src.open("INBOX");
    const msgs = await drain(src.fetchSince(head, 100));
    expect(msgs).toHaveLength(60);
    expect(msgs[0]).toMatchObject({ id: "id-00", cursor: "2026-11-03T10:00:00Z" });
    expect(msgs[0]!.source.toString()).toContain("Subject: msg id-00");
    expect(msgs[0]!.webLink).toMatch(/^https:\/\/outlook\.office365\.com\/owa\/\?ItemID=/);

    const list = graph.api.callsTo(/mailFolders\/[^/]+\/messages$/)[0]!;
    expect(list.url.searchParams.get("$filter")).toBe(
      "receivedDateTime ge 2026-11-03T10:00:00.000Z",
    );
    expect(list.url.searchParams.get("$orderby")).toBe("receivedDateTime asc");
    expect(list.url.searchParams.get("$select")).toBe("id,receivedDateTime,webLink");
  });

  it("re-lists messages at the boundary time (the pipeline drops them as processed)", async () => {
    const graph = new FakeGraph();
    graph.add("a", "2026-11-03T11:00:00Z");
    graph.add("b", "2026-11-03T11:05:00Z");
    const src = source(graph);
    await src.open("INBOX");
    expect((await drain(src.fetchSince("2026-11-03T11:00:00Z", 10))).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
    expect((await drain(src.fetchSince("2026-11-03T11:00:00Z", 1))).map((m) => m.id)).toEqual([
      "a",
    ]);
  });

  it("asks for immutable IDs and only reads (FR-109)", async () => {
    const graph = new FakeGraph();
    graph.add("a", "2026-11-03T11:00:00Z");
    const src = source(graph);
    await src.open("INBOX");
    await drain(src.fetchSince("2026-11-01T00:00:00Z", 10));
    for (const call of graph.api.calls) {
      expect(call.method).toBe("GET");
      expect(call.headers.prefer).toBe('IdType="ImmutableId"');
    }
  });

  it("surfaces an access error from the organization", async () => {
    const graph = new FakeGraph();
    graph.api.once("GET", /mailFolders\/inbox$/, {
      status: 403,
      json: { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
    });
    const err = (await source(graph)
      .open("INBOX")
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain("ErrorAccessDenied");
  });
});
