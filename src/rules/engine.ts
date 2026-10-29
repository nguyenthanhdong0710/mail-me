import type { IncomingEmail, RuleDecision } from "../domain/types.js";

export interface RuleContext {
  installId: string;
  isProcessed: (email: IncomingEmail) => boolean;
}

/** True when the `X-Mail-Me` marker carries this installation's id (research R15). */
export function isSelfSent(marker: string | null, installId: string): boolean {
  if (!marker) return false;
  return /\bid=([0-9a-f-]+)/i.exec(marker)?.[1]?.toLowerCase() === installId.toLowerCase();
}

/**
 * Deterministic rules that run before any LLM call (FR-003). Order matters:
 * already processed → self-sent → (whitelist → drop keyword, added in US2) → LLM.
 */
export function evaluateRules(email: IncomingEmail, ctx: RuleContext): RuleDecision {
  if (ctx.isProcessed(email)) return { kind: "ALREADY_PROCESSED" };
  if (isSelfSent(email.selfSentMarker, ctx.installId)) return { kind: "SELF_SENT" };
  return { kind: "NEEDS_LLM" };
}
