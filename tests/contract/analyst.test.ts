import { describe, expect, it } from "vitest";
import { analystSystemPrompt, analyze } from "../../src/agents/analyst.js";
import { AnalysisSchema } from "../../src/domain/types.js";
import { analysis, FakeLlm } from "../fakes/index.js";

const email = {
  from: { address: "prof@university.edu" },
  subject: "Assignment 3",
  text: "Due Friday",
  truncated: true,
  attachments: [],
};
const fast = { attempts: 2, sleep: async () => {} };

describe("analyst output schema", () => {
  it("accepts a valid result, including null deadlines", () => {
    expect(
      AnalysisSchema.safeParse(analysis({ action_items: [{ action: "Đọc", deadline: null }] }))
        .success,
    ).toBe(true);
  });

  it.each([
    ["empty summary", analysis({ summary: "" })],
    ["too many key points", analysis({ key_points: Array(11).fill("x") })],
    ["string action items (blueprint format)", analysis({ action_items: ["Submit (Friday)"] })],
    ["missing urgency flag", { ...analysis(), requires_immediate_attention: undefined }],
  ])("rejects %s", (_label, value) => {
    expect(AnalysisSchema.safeParse(value).success).toBe(false);
  });
});

describe("analyze", () => {
  it("puts the target language in the prompt and passes the truncated flag", async () => {
    const llm = new FakeLlm();
    const res = await analyze(llm, email, { targetLanguage: "Vietnamese", retry: fast });
    expect(res.value.summary).toContain("Bài tập 3");
    expect(llm.calls[0]!.system).toContain("target language: Vietnamese");
    expect(llm.calls[0]!.system).not.toContain("{{TARGET_LANGUAGE}}");
    expect(llm.calls[0]!.user).toContain("<truncated>true</truncated>");
  });

  it("throws after the final retry", async () => {
    const llm = new FakeLlm({ analyst: () => ({ summary: "" }) });
    await expect(
      analyze(llm, email, { targetLanguage: "Vietnamese", retry: fast }),
    ).rejects.toThrow();
    expect(llm.callsFor("analyst")).toBe(2);
  });

  it("tells the model not to translate text already in the target language", () => {
    expect(analystSystemPrompt("Vietnamese")).toContain(
      "already written in Vietnamese, do not translate",
    );
  });
});
