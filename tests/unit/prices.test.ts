import { describe, expect, it } from "vitest";
import { BUILT_IN_PRICES, estimateCost } from "../../src/agents/prices.js";

const table = {
  "openai/gpt-5": { input_per_mtok: 1.25, output_per_mtok: 10 },
  "openai/gpt-5-mini": { input_per_mtok: 0.25, output_per_mtok: 2 },
};
const usage = { input: 1_000_000, output: 100_000 };

describe("estimateCost (FR-123, contracts/ai-usage.contract.md)", () => {
  it("prices an exact built-in model", () => {
    expect(estimateCost("openai", "gpt-5-mini", usage, {}, table)).toBe(0.45);
  });

  it("prices dated snapshots by the longest prefix, at an ID boundary only", () => {
    expect(estimateCost("openai", "gpt-5-mini-2026-08-07", usage, {}, table)).toBe(0.45);
    expect(estimateCost("openai", "gpt-50", usage, {}, table)).toBeNull();
    expect(estimateCost("anthropic", "gpt-5", usage, {}, table)).toBeNull();
  });

  it("lets a config override win", () => {
    const overrides = { "gpt-5-mini": { input_per_mtok: 0, output_per_mtok: 0 } };
    expect(estimateCost("openai", "gpt-5-mini", usage, overrides, table)).toBe(0);
    expect(
      estimateCost(
        "openai",
        "my-local",
        usage,
        { "my-local": { input_per_mtok: 1, output_per_mtok: 1 } },
        table,
      ),
    ).toBe(1.1);
  });

  it("returns null for an unknown model and rounds to 6 decimals", () => {
    expect(estimateCost("openai", "mystery", usage, {}, table)).toBeNull();
    expect(estimateCost("openai", "gpt-5-mini", { input: 1, output: 1 }, {}, table)).toBe(0.000002);
  });

  it("ships prices for the models in config.example.json", () => {
    expect(BUILT_IN_PRICES["openai/gpt-5-mini"]).toBeDefined();
    expect(BUILT_IN_PRICES["anthropic/claude-haiku-5-5"]).toBeDefined();
  });
});
