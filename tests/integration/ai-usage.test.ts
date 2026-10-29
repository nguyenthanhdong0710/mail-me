import { Writable } from "node:stream";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AiSdkLlmClient } from "../../src/agents/llm.js";
import type { ModelConfig } from "../../src/config/load.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/poller.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { analysis, FakeChannel, FakeClock, FakeMailServer, important } from "../fakes/index.js";
import { eml } from "../fixtures/load.js";

const OUTPUT: Record<string, unknown> = {
  "gpt-5-mini": important(),
  "claude-haiku-5-5": analysis(),
  "sched-model": { events: [] },
  "mystery-model": important(),
};

function model(cfg: ModelConfig) {
  return new MockLanguageModelV4({
    provider: cfg.provider,
    modelId: cfg.model,
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify(OUTPUT[cfg.model]) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 2000, noCache: 2000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 400, text: 400, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

async function run(gatekeeperModel: string, emails: string[]) {
  const config = testConfig((raw) => {
    const ai = raw.ai as Record<string, Record<string, unknown>>;
    ai.gatekeeper = { provider: "openai", model: gatekeeperModel, api_key_env: "OPENAI_API_KEY" };
    ai.analyst = {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      api_key_env: "ANTHROPIC_API_KEY",
    };
    ai.scheduler = { provider: "openai", model: "sched-model", api_key_env: "OPENAI_API_KEY" };
    (raw.ai as Record<string, unknown>).prices = {
      "sched-model": { input_per_mtok: 1, output_per_mtok: 1 },
    };
    (raw.rules as unknown) = { drop_keywords: ["discount"] };
  });
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger(
    { level: "info" },
    new Writable({
      write(chunk, _e, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    }),
  );
  const llm = new AiSdkLlmClient(config.ai, {
    concurrency: 1,
    prices: config.ai.prices,
    logger,
    modelFactory: model,
  });
  const store = new SqliteStore(":memory:");
  const server = new FakeMailServer();
  const pipeline = new Pipeline({
    config,
    store,
    llm,
    channels: new Map([["email", new FakeChannel("email")]]),
    sources: server.factory(),
    clock: new FakeClock(),
    logger,
    retry: { attempts: 1, sleep: async () => {} },
  });
  await runOnce(pipeline, config.accounts, logger);
  for (const subject of emails) server.deliver("school", eml({ subject, from: "x@other.example" }));
  await runOnce(pipeline, config.accounts, logger);
  return { lines, store };
}

describe("AI cost in the logs (US5, SC-108)", () => {
  it("logs every call and an email total equal to their sum", async () => {
    const { lines, store } = await run("gpt-5-mini", ["Assignment"]);
    const calls = lines.filter((l) => l.msg === "ai call");
    expect(calls.map((c) => c.role)).toEqual(["gatekeeper", "analyst", "scheduler"]);
    for (const c of calls) {
      expect(c).toMatchObject({ tokensIn: 2000, tokensOut: 400, account: "school" });
      expect(typeof c.ms).toBe("number");
    }
    // gpt-5-mini: 2000×0.25 + 400×2 = 0.0013; haiku 5.5: 2000×0.1 + 400×0.5 = 0.0004; override: 0.0024
    expect(calls.map((c) => c.costUsd)).toEqual([0.0013, 0.0004, 0.0024]);
    const email = lines.find((l) => l.msg === "email reported")!;
    expect(email).toMatchObject({
      aiCalls: 3,
      costUsd: 0.0041,
      tokens: { input: 6000, output: 1200 },
    });
    const key = { accountId: "school", mailbox: "INBOX", uidValidity: "1", uid: "1" };
    expect(store.getProcessed(key)?.cost_usd).toBe(0.0041);
  });

  it("logs unknown cost with one warning per model, and 0 for rules-only emails", async () => {
    const { lines } = await run("mystery-model", ["First", "Second", "Big discount"]);
    const warnings = lines.filter((l) => l.msg === "no price for model, cost unknown");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.hint).toContain('ai.prices["mystery-model"]');
    const totals = lines.filter((l) => l.msg === "email reported").map((l) => l.costUsd);
    expect(totals).toEqual([null, null]);
    const dropped = lines.find((l) => l.msg === "email skipped" && l.decision === "DROP_KEYWORD")!;
    expect(dropped).toMatchObject({ aiCalls: 0, costUsd: 0 });
  });
});
