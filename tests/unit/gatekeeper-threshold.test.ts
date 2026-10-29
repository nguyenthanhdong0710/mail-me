import { describe, expect, it } from "vitest";
import { classify, effectiveCategory } from "../../src/agents/gatekeeper.js";
import { FakeLlm } from "../fakes/index.js";

const email = { from: { address: "a@b.example" }, subject: "Hi", text: "Body" };
const fast = { attempts: 1, sleep: async () => {} };

describe("confidence threshold (FR-005)", () => {
  it("turns a low-confidence PROMOTION into IMPORTANT", () => {
    const r = effectiveCategory(
      { category: "PROMOTION", confidence_score: 0.5, reasoning: "" },
      0.7,
    );
    expect(r).toEqual({ category: "IMPORTANT", lowConfidence: true });
  });

  it("keeps a confident SPAM", () => {
    const r = effectiveCategory({ category: "SPAM", confidence_score: 0.9, reasoning: "" }, 0.7);
    expect(r).toEqual({ category: "SPAM", lowConfidence: false });
  });

  it("keeps a verdict exactly at the threshold", () => {
    const r = effectiveCategory({ category: "SPAM", confidence_score: 0.7, reasoning: "" }, 0.7);
    expect(r.category).toBe("SPAM");
  });

  it("never downgrades IMPORTANT, whatever the confidence", () => {
    const r = effectiveCategory(
      { category: "IMPORTANT", confidence_score: 0.1, reasoning: "" },
      0.7,
    );
    expect(r).toEqual({ category: "IMPORTANT", lowConfidence: false });
  });

  it("applies the configured threshold in classify()", async () => {
    const llm = new FakeLlm({
      gatekeeper: () => ({ category: "PROMOTION", confidence_score: 0.5, reasoning: "ad" }),
    });
    expect((await classify(llm, email, { threshold: 0.7, retry: fast })).effective).toBe(
      "IMPORTANT",
    );
    expect((await classify(llm, email, { threshold: 0.4, retry: fast })).effective).toBe(
      "PROMOTION",
    );
  });
});
