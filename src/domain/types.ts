import { z } from "zod";

export const CATEGORIES = ["SPAM", "PROMOTION", "IMPORTANT"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Address {
  name?: string;
  address: string;
}

/** Identity of a message inside one mailbox generation (see research R2). */
export interface MessageKey {
  accountId: string;
  uidValidity: number;
  uid: number;
}

export interface IncomingEmail extends MessageKey {
  mailbox: string;
  messageId: string | null;
  from: Address;
  subject: string;
  receivedAt: Date;
  /** Cleaned, truncated plain-text body. */
  text: string;
  truncated: boolean;
  attachments: string[];
  /** Value of the `X-Mail-Me` header, used to detect our own reports (FR-022). */
  selfSentMarker: string | null;
}

export type RuleDecision =
  | { kind: "ALREADY_PROCESSED" }
  | { kind: "SELF_SENT" }
  | { kind: "WHITELIST"; domain: string }
  | { kind: "DROP_KEYWORD"; keyword: string }
  | { kind: "NEEDS_LLM" };

// Agent output schemas (contracts/gatekeeper.contract.md, contracts/analyst.contract.md).

export const ClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  confidence_score: z.number().min(0).max(1),
  reasoning: z.string().max(300),
});
export type ClassificationResult = z.infer<typeof ClassificationSchema>;

export const AnalysisSchema = z.object({
  original_language: z.string().min(1),
  summary: z.string().min(1).max(1000),
  key_points: z.array(z.string()).max(10),
  action_items: z.array(z.object({ action: z.string(), deadline: z.string().nullable() })).max(10),
  requires_immediate_attention: z.boolean(),
});
export type AnalysisResult = z.infer<typeof AnalysisSchema>;

export type ChannelName = "email" | "telegram";

/** Channel-neutral result for one important email (contracts/delivery.contract.md). */
export interface Report {
  key: MessageKey;
  source: { accountId: string; label: string };
  original: {
    messageId: string | null;
    from: Address;
    subject: string;
    receivedAt: string;
  };
  kind: "SUMMARY" | "FALLBACK";
  analysis: AnalysisResult | null;
  excerpt: string;
  truncated: boolean;
  urgent: boolean;
  actionNeeded: boolean;
}

export type Decision = "SELF_SENT" | "WHITELIST" | "DROP_KEYWORD" | "LLM";
export type Outcome = "FORWARDED" | "SKIPPED" | "FALLBACK_FORWARDED" | "DELIVERY_FAILED";

export interface ProcessedRecord {
  key: MessageKey;
  messageId: string | null;
  sender: string;
  subject: string;
  decision: Decision;
  category: Category | null;
  confidence: number | null;
  outcome: Outcome;
  tokensIn: number | null;
  tokensOut: number | null;
  processedAt: string;
}

/** Everything about a record except its final outcome, kept while delivery is pending. */
export type DraftRecord = Omit<ProcessedRecord, "outcome" | "processedAt">;

export interface MailboxState {
  accountId: string;
  mailbox: string;
  uidValidity: number;
  lastSeenUid: number;
}

export type DeliveryStatus = "PENDING" | "DELIVERED" | "GAVE_UP";

export interface DeliveryRow {
  key: MessageKey;
  channel: ChannelName;
  status: DeliveryStatus;
  attempts: number;
  partsSent: number;
  externalId: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
}

export interface PendingReport {
  report: Report;
  draft: DraftRecord;
  deliveries: DeliveryRow[];
}

export interface LlmUsage {
  input: number;
  output: number;
}
