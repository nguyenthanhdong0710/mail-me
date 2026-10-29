import type { LlmClient } from "../domain/ports.js";
import {
  ClassificationSchema,
  type Category,
  type ClassificationResult,
  type IncomingEmail,
  type LlmUsage,
} from "../domain/types.js";
import { retry, type RetryOptions } from "../lib/retry.js";
import { emailBlock, loadPrompt } from "./prompt.js";

export interface GatekeeperVerdict {
  /** The category the pipeline acts on, after fail-open and threshold rules. */
  effective: Category;
  result: ClassificationResult | null;
  failed: boolean;
  lowConfidence: boolean;
  usage: LlmUsage | null;
}

/**
 * Applies the code-side rules (contracts/gatekeeper.contract.md): a failure or a low-confidence
 * SPAM/PROMOTION verdict becomes IMPORTANT, so mail is never silently dropped.
 */
export function effectiveCategory(
  result: ClassificationResult,
  threshold: number,
): { category: Category; lowConfidence: boolean } {
  const lowConfidence = result.category !== "IMPORTANT" && result.confidence_score < threshold;
  return { category: lowConfidence ? "IMPORTANT" : result.category, lowConfidence };
}

export async function classify(
  llm: LlmClient,
  email: Pick<IncomingEmail, "from" | "subject" | "text">,
  opts: { threshold: number; retry?: RetryOptions },
): Promise<GatekeeperVerdict> {
  try {
    const { value, usage } = await retry(
      () =>
        llm.generate("gatekeeper", {
          system: loadPrompt("gatekeeper.v1"),
          user: emailBlock(email),
          schema: ClassificationSchema,
        }),
      opts.retry,
    );
    const { category, lowConfidence } = effectiveCategory(value, opts.threshold);
    return { effective: category, result: value, failed: false, lowConfidence, usage };
  } catch {
    return {
      effective: "IMPORTANT",
      result: null,
      failed: true,
      lowConfidence: false,
      usage: null,
    };
  }
}
