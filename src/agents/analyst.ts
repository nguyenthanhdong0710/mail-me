import type { LlmClient } from "../domain/ports.js";
import {
  AnalysisSchema,
  type AnalysisResult,
  type IncomingEmail,
  type LlmUsage,
} from "../domain/types.js";
import type { Logger } from "../lib/logger.js";
import { retry, type RetryOptions } from "../lib/retry.js";
import { emailBlock, loadPrompt } from "./prompt.js";

/** Prompt per report style: brief (default, 002) or the 001 detailed prompt (FR-111). */
const PROMPTS = { brief: "analyst.brief.v1", detailed: "analyst.v1" } as const;

export function analystSystemPrompt(
  targetLanguage: string,
  style: "brief" | "detailed" = "detailed",
): string {
  return loadPrompt(PROMPTS[style]).replaceAll("{{TARGET_LANGUAGE}}", targetLanguage);
}

/** Summarizes and translates one important email. Throws after the final retry. */
export async function analyze(
  llm: LlmClient,
  email: Pick<IncomingEmail, "from" | "subject" | "text" | "truncated" | "attachments">,
  opts: {
    targetLanguage: string;
    style?: "brief" | "detailed";
    retry?: RetryOptions;
    log?: Logger;
  },
): Promise<{ value: AnalysisResult; usage: LlmUsage }> {
  const user = `${emailBlock(email)}\n<truncated>${email.truncated}</truncated>`;
  return retry(
    () =>
      llm.generate("analyst", {
        system: analystSystemPrompt(opts.targetLanguage, opts.style),
        user,
        schema: AnalysisSchema,
        log: opts.log,
      }),
    opts.retry,
  );
}
