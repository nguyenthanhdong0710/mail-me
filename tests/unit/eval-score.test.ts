import { describe, expect, it } from "vitest";
import { score, type Sample } from "../../scripts/eval-gatekeeper.js";

const s = (label: Sample["label"], predicted: Sample["predicted"]): Sample => ({
  file: `${label}.eml`,
  label,
  predicted,
  via: "LLM",
});

describe("eval-gatekeeper score (SC-003)", () => {
  it("passes with no important dropped and 80% noise filtered", () => {
    const r = score([
      s("important", "IMPORTANT"),
      ...Array.from({ length: 4 }, () => s("promotion", "PROMOTION")),
      s("spam", "IMPORTANT"),
    ]);
    expect(r).toMatchObject({
      total: 6,
      noise: 5,
      noiseFiltered: 4,
      filterRate: 0.8,
      passed: true,
    });
  });

  it("fails when a single important email is dropped", () => {
    const r = score([s("important", "SPAM"), s("spam", "SPAM")]);
    expect(r.passed).toBe(false);
    expect(r.importantDropped).toHaveLength(1);
  });

  it("fails below 80% filtering", () => {
    expect(score([s("spam", "SPAM"), s("promotion", "IMPORTANT")]).passed).toBe(false);
  });
});
