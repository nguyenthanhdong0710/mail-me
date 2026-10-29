import { describe, expect, it } from "vitest";
import {
  BRIEF_LIMITS,
  clampPoints,
  clampSummary,
  clampWords,
  firstSentences,
  wordCount,
} from "../../src/courier/clamp.js";

describe("brief limits (FR-111, contracts/report.contract.md)", () => {
  it("keeps at most 2 sentences and 40 words in the TL;DR", () => {
    const long = "One two three. Four five six! Seven eight nine? Ten.";
    expect(firstSentences(long, 2)).toBe("One two three. Four five six!");
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const out = clampSummary(words);
    expect(wordCount(out)).toBe(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps at most 3 points of at most 15 words", () => {
    const points = Array.from({ length: 6 }, (_, i) => `point ${i} ` + "word ".repeat(30));
    const out = clampPoints(points);
    expect(out).toHaveLength(3);
    for (const p of out) expect(wordCount(p)).toBeLessThanOrEqual(15);
  });

  it("leaves short text alone and trims trailing punctuation before the ellipsis", () => {
    expect(clampWords("Short text.", 15, 120)).toBe("Short text.");
    expect(clampWords("a b c, d", 3, 120)).toBe("a b c…");
  });

  it("falls back to characters for text without spaces", () => {
    const zh = "这是一个没有空格的很长的句子".repeat(20);
    const out = clampWords(zh, BRIEF_LIMITS.pointWords, BRIEF_LIMITS.pointChars);
    expect([...out]).toHaveLength(BRIEF_LIMITS.pointChars + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});
