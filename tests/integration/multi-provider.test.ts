import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { logStartupNotices } from "../../src/config/notices.js";
import type { TokenProvider } from "../../src/domain/ports.js";
import { GraphMailSource } from "../../src/fetcher/graph-source.js";
import { mailSourceFactory } from "../../src/fetcher/index.js";
import { ApiClient } from "../../src/lib/api-client.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/poller.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { rawConfig, testEnv } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer } from "../fakes/index.js";
import { FakeGraph } from "../fixtures/http/graph.js";
import { eml } from "../fixtures/load.js";

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, logger: createLogger({ level: "info" }, stream) };
}

function config() {
  const raw = rawConfig() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test mutation
  raw.auth = { microsoft: { client_id: "app-id" } };
  raw.accounts = [
    { id: "outlook", label: "Outlook", email: "me@outlook.com", provider: "microsoft" },
    {
      id: "yahoo",
      label: "Yahoo",
      email: "me@yahoo.com",
      provider: "yahoo",
      imap: { password_env: "SCHOOL_IMAP_PASSWORD" },
    },
    {
      id: "old-gmail",
      email: "old@gmail.com",
      imap: { host: "imap.gmail.com", password_env: "SCHOOL_IMAP_PASSWORD" },
    },
  ];
  return parseConfig(raw, testEnv);
}

describe("several providers at once (US2)", () => {
  it("reports mail from an Outlook (Graph) account and a Yahoo (IMAP) account, each labeled", async () => {
    const cfg = config();
    const graph = new FakeGraph();
    const imap = new FakeMailServer();
    const tokens: TokenProvider = { accessToken: async () => "t", invalidate: () => {} };
    let now = new Date("2026-11-03T09:00:00Z");
    const oauthSources = mailSourceFactory(
      cfg.accounts,
      (account) =>
        new GraphMailSource(
          new ApiClient(graph.api.fetch, tokens, account.grant!, "graph"),
          () => now,
        ),
    );
    // Password accounts read from the fake IMAP server instead of a real one.
    const sources = (id: string) => (id === "yahoo" ? imap.factory()(id) : oauthSources(id));
    const store = new SqliteStore(":memory:");
    const channel = new FakeChannel("email");
    const { logger } = capture();
    const pipeline = new Pipeline({
      config: cfg,
      store,
      llm: new FakeLlm(),
      channels: new Map([["email", channel]]),
      sources,
      clock: new FakeClock(),
      logger,
      retry: { attempts: 1, sleep: async () => {} },
    });
    const accounts = cfg.accounts.slice(0, 2);

    await runOnce(pipeline, accounts, logger); // baseline
    now = new Date("2026-11-03T10:00:00Z");
    graph.add("AAMk-1", "2026-11-03T09:30:00Z");
    imap.deliver("yahoo", eml({ subject: "Yahoo news" }));
    await runOnce(pipeline, accounts, logger);

    expect(channel.delivered.map((r) => [r.source.label, r.original.subject]).sort()).toEqual([
      ["Outlook", "msg AAMk-1"],
      ["Yahoo", "Yahoo news"],
    ]);
    expect(channel.delivered.find((r) => r.source.label === "Outlook")!.key.uidValidity).toBe(
      "AAMkInbox==",
    );
  });

  it("logs a one-time notice per password account and a hint for Gmail over IMAP (FR-106)", () => {
    const { lines, logger } = capture();
    logStartupNotices(config(), logger);
    const msgs = lines.map((l) => l.msg as string);
    expect(
      msgs.filter((m) => m.includes("uses a password, which is less safe than OAuth")),
    ).toHaveLength(2);
    expect(msgs.some((m) => m.includes('"old-gmail" is a Gmail account'))).toBe(true);
    expect(msgs.some((m) => m.includes('"outlook"'))).toBe(false);
  });
});
