import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { analyze } from "../../src/agents/analyst.js";
import { classify } from "../../src/agents/gatekeeper.js";
import { AiSdkLlmClient, createModel } from "../../src/agents/llm.js";
import type { ModelConfig } from "../../src/config/load.js";
import { testConfig } from "../fakes/config.js";
import { analysis, important } from "../fakes/index.js";

const email = {
  from: { address: "prof@university.edu" },
  subject: "Assignment 3",
  text: "Due Friday 5pm.",
  truncated: false,
  attachments: [],
};
const fast = { attempts: 1, sleep: async () => {} };

function mockModel(cfg: ModelConfig, output: unknown) {
  return new MockLanguageModelV4({
    provider: cfg.provider,
    modelId: cfg.model,
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

describe("separate model per role (FR-015)", () => {
  it("builds each role from its own provider and model", () => {
    const { ai } = testConfig();
    const gk = createModel(ai.gatekeeper);
    const an = createModel(ai.analyst);
    expect(typeof gk !== "string" && gk.modelId).toBe("small-model");
    expect(typeof gk !== "string" && gk.provider).toMatch(/^openai/);
    expect(typeof an !== "string" && an.modelId).toBe("strong-model");
    expect(typeof an !== "string" && an.provider).toMatch(/^anthropic/);
  });

  it("supports google as a provider", () => {
    const m = createModel({ provider: "google", model: "g-model", apiKey: "k" });
    expect(typeof m !== "string" && m.provider).toMatch(/^google/);
  });

  it("sends Gatekeeper calls to the gatekeeper model and Analyst calls to the analyst model", async () => {
    const { ai } = testConfig();
    const models = new Map<string, MockLanguageModelV4>();
    const client = new AiSdkLlmClient(ai, 2, (cfg) => {
      const m = mockModel(cfg, cfg === ai.gatekeeper ? important() : analysis());
      models.set(cfg.model, m);
      return m;
    });
    const gatekeeper = models.get("small-model")!;
    const analyst = models.get("strong-model")!;

    const verdict = await classify(client, email, { threshold: 0.7, retry: fast });
    expect(verdict).toMatchObject({ effective: "IMPORTANT", failed: false });
    expect(verdict.usage).toEqual({ input: 50, output: 10 });
    expect(gatekeeper.doGenerateCalls).toHaveLength(1);
    expect(analyst.doGenerateCalls).toHaveLength(0);
    expect(gatekeeper.doGenerateCalls[0]!.temperature).toBe(0);

    const res = await analyze(client, email, { targetLanguage: "Vietnamese", retry: fast });
    expect(res.value.summary).toContain("Bài tập 3");
    expect(analyst.doGenerateCalls).toHaveLength(1);
    expect(gatekeeper.doGenerateCalls).toHaveLength(1);
  });

  it("fails open when the model returns output that breaks the schema", async () => {
    const { ai } = testConfig();
    const client = new AiSdkLlmClient(ai, 1, (cfg) =>
      mockModel(cfg, { category: "URGENT", confidence_score: 2 }),
    );
    const verdict = await classify(client, email, { threshold: 0.7, retry: fast });
    expect(verdict).toMatchObject({ effective: "IMPORTANT", failed: true });
  });
});
