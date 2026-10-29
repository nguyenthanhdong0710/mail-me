import type { LlmClient } from "../domain/ports.js";
import {
  AnalysisSchema,
  type AnalysisResult,
  type IncomingEmail,
  type LlmUsage,
} from "../domain/types.js";
import { retry, type RetryOptions } from "../lib/retry.js";
import { emailBlock, loadPrompt } from "./prompt.js";

export function analystSystemPrompt(targetLanguage: string): string {
  return loadPrompt("analyst.v1").replaceAll("{{TARGET_LANGUAGE}}", targetLanguage);
}

/** Summarizes and translates one important email. Throws after the final retry. */
export async function analyze(
  llm: LlmClient,
  email: Pick<IncomingEmail, "from" | "subject" | "text" | "truncated" | "attachments">,
  opts: { targetLanguage: string; retry?: RetryOptions },
): Promise<{ value: AnalysisResult; usage: LlmUsage }> {
  const user = `${emailBlock(email)}\n<truncated>${email.truncated}</truncated>`;
  return retry(
    () =>
      llm.generate("analyst", {
        system: analystSystemPrompt(opts.targetLanguage),
        user,
        schema: AnalysisSchema,
      }),
    opts.retry,
  );
}
