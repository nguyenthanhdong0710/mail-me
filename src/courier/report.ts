import type { AnalysisResult, IncomingEmail, Report } from "../domain/types.js";

export function buildReport(
  email: IncomingEmail,
  source: { accountId: string; label: string },
  analysis: AnalysisResult | null,
  excerptChars: number,
): Report {
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
    },
    kind: analysis ? "SUMMARY" : "FALLBACK",
    analysis,
    excerpt,
    truncated: email.truncated,
    urgent: analysis?.requires_immediate_attention ?? false,
    actionNeeded: (analysis?.action_items.length ?? 0) > 0,
  };
}

export function formatSender(from: Report["original"]["from"]): string {
  return from.name ? `${from.name} <${from.address}>` : from.address;
}
