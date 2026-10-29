import { sameMailbox } from "../config/address.js";
import type {
  Address,
  AnalysisResult,
  DetectedEvent,
  IncomingEmail,
  RecipientList,
  Report,
} from "../domain/types.js";
import { BRIEF_LIMITS, clampPoints, clampSummary } from "./clamp.js";

/** At most this many recipients per list are shown (FR-128). */
export const MAX_RECIPIENTS = 5;

export interface ReportOptions {
  excerptChars: number;
  style: "brief" | "detailed";
  timezone: string;
  events?: DetectedEvent[];
  eventsOmitted?: number;
  schedulerFailed?: boolean;
}

function recipientList(list: Address[]): RecipientList {
  return { shown: list.slice(0, MAX_RECIPIENTS), more: Math.max(0, list.length - MAX_RECIPIENTS) };
}

/** Brief style keeps reports readable at a glance; limits are applied here, not by the AI. */
function briefAnalysis(a: AnalysisResult): AnalysisResult {
  return { ...a, summary: clampSummary(a.summary), key_points: clampPoints(a.key_points) };
}

export function buildReport(
  email: IncomingEmail,
  source: { accountId: string; label: string },
  analysis: AnalysisResult | null,
  opts: ReportOptions,
): Report {
  const brief = opts.style === "brief";
  const excerptChars = brief
    ? Math.min(opts.excerptChars, BRIEF_LIMITS.excerptChars)
    : opts.excerptChars;
  const excerpt =
    email.text.length > excerptChars
      ? `${email.text.slice(0, excerptChars).trimEnd()}…`
      : email.text;
  return {
    key: {
      accountId: email.accountId,
      mailbox: email.mailbox,
      uidValidity: email.uidValidity,
      uid: email.uid,
    },
    source,
    original: {
      messageId: email.messageId,
      from: email.from,
      subject: email.subject,
      receivedAt: email.receivedAt.toISOString(),
      to: recipientList(email.to),
      cc: recipientList(email.cc),
      deliveredTo: email.deliveredTo,
      addressedToYou: email.addressedToYou,
      webLink: email.webLink,
    },
    kind: analysis ? "SUMMARY" : "FALLBACK",
    style: opts.style,
    timezone: opts.timezone,
    events: opts.events ?? [],
    eventsOmitted: opts.eventsOmitted ?? 0,
    schedulerFailed: opts.schedulerFailed ?? false,
    analysis: analysis && brief ? briefAnalysis(analysis) : analysis,
    excerpt,
    truncated: email.truncated,
    urgent: analysis?.requires_immediate_attention ?? false,
    actionNeeded: (analysis?.action_items.length ?? 0) > 0,
  };
}

export function formatSender(from: Report["original"]["from"]): string {
  return from.name ? `${from.name} <${from.address}>` : from.address;
}

/**
 * `To: Alice, you, Bob and 4 more · Cc: Carol`, or `… · received at you@x` when the monitored
 * address is not among the recipients (Bcc, alias, forward). Null for 001 reports.
 */
export function recipientLine(o: Report["original"]): string | null {
  if (!o.to && !o.cc && !o.deliveredTo) return null;
  const isYou = (a: Address) => !!o.deliveredTo && sameMailbox(a.address, o.deliveredTo);
  const format = (list: RecipientList) =>
    list.shown.map((a) => (isYou(a) ? "you" : a.name || a.address)).join(", ") +
    (list.more > 0 ? ` and ${list.more} more` : "");
  const parts: string[] = [];
  if (o.to?.shown.length) parts.push(`To: ${format(o.to)}`);
  if (o.cc?.shown.length) parts.push(`Cc: ${format(o.cc)}`);
  if (parts.length === 0) parts.push("undisclosed recipients");
  if (o.deliveredTo && !o.addressedToYou) parts.push(`received at ${o.deliveredTo}`);
  return parts.join(" · ");
}
