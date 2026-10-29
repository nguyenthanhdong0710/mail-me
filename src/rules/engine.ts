import type { IncomingEmail, RuleDecision } from "../domain/types.js";

export interface RuleConfig {
  whitelistDomains: string[];
  dropKeywords: string[];
}

export interface RuleContext {
  installId: string;
  isProcessed: (email: IncomingEmail) => boolean;
  rules?: RuleConfig;
}

/** True when the `X-Mail-Me` marker carries this installation's id (research R15). */
export function isSelfSent(marker: string | null, installId: string): boolean {
  if (!marker) return false;
  return /\bid=([0-9a-f-]+)/i.exec(marker)?.[1]?.toLowerCase() === installId.toLowerCase();
}

/** `@University.edu` → `university.edu`. */
export function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^@+/, "").toLowerCase();
}

/** The whitelisted domain the address belongs to (exact or subdomain), if any. */
export function matchWhitelist(address: string, domains: string[]): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const host = address.slice(at + 1).toLowerCase();
  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    if (domain && (host === domain || host.endsWith(`.${domain}`))) return domain;
  }
  return null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = /[\p{L}\p{N}_]/u;

/**
 * Case-insensitive whole-word matcher (research R9). Word boundaries only apply at the ends of
 * the keyword that are word characters, so "% off" still matches "50% off".
 */
export function keywordPattern(keyword: string): RegExp {
  const k = keyword.trim();
  const start = WORD.test(k.charAt(0)) ? "(?<![\\p{L}\\p{N}_])" : "";
  const end = WORD.test(k.charAt(k.length - 1)) ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(`${start}${escapeRegExp(k)}${end}`, "iu");
}

/** The first drop keyword found in the subject or sender. The body is never checked. */
export function matchDropKeyword(
  email: Pick<IncomingEmail, "from" | "subject">,
  keywords: string[],
): string | null {
  const haystacks = [email.subject, email.from.name ?? "", email.from.address];
  for (const keyword of keywords) {
    if (!keyword.trim()) continue;
    const pattern = keywordPattern(keyword);
    if (haystacks.some((h) => pattern.test(h))) return keyword;
  }
  return null;
}

/**
 * Deterministic rules that run before any LLM call (FR-003). Order matters:
 * already processed → self-sent → whitelist → drop keyword → LLM.
 */
export function evaluateRules(email: IncomingEmail, ctx: RuleContext): RuleDecision {
  if (ctx.isProcessed(email)) return { kind: "ALREADY_PROCESSED" };
  if (isSelfSent(email.selfSentMarker, ctx.installId)) return { kind: "SELF_SENT" };
  if (ctx.rules) {
    const domain = matchWhitelist(email.from.address, ctx.rules.whitelistDomains);
    if (domain) return { kind: "WHITELIST", domain };
    const keyword = matchDropKeyword(email, ctx.rules.dropKeywords);
    if (keyword) return { kind: "DROP_KEYWORD", keyword };
  }
  return { kind: "NEEDS_LLM" };
}
