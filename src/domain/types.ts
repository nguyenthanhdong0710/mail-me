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
  /** UIDs are only unique within one mailbox, so the mailbox is part of the key. */
  mailbox: string;
  /** IMAP UIDVALIDITY, or the provider's generation (002 research R2). */
  uidValidity: string;
  /** IMAP UID, Gmail message ID or Graph immutable ID. */
  uid: string;
}

export interface IncomingEmail extends MessageKey {
  messageId: string | null;
  from: Address;
  /** To and Cc recipients (names sanitized), for the report (FR-128). */
  to: Address[];
  cc: Address[];
  /** The monitored address that received the message. */
  deliveredTo: string;
  /** Whether deliveredTo appears in To or Cc; false for Bcc, aliases and forwards. */
  addressedToYou: boolean;
  /** "Open original" link, built by code for providers that have one (FR-129). */
  webLink: string | null;
  subject: string;
  receivedAt: Date;
  /** The Date header with its original UTC offset, for resolving relative dates. */
  sentAt: string;
  /** Raw text/calendar parts (invitations), at most 3. */
  calendarParts: string[];
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

// Scheduler output schema (002 contracts/scheduler.contract.md). Times are local; code converts.
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);

export const SchedulerSchema = z.object({
  events: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        status: z.enum(["new", "rescheduled", "cancelled"]),
        time_known: z.boolean(),
        all_day: z.boolean(),
        start_local: localDateTime.nullable(),
        end_local: localDateTime.nullable(),
        duration_minutes: z
          .number()
          .int()
          .min(1)
          .max(60 * 24 * 14)
          .nullable(),
        timezone: z.string().max(64).nullable(),
        location: z.string().max(200).nullable(),
        meeting_url: z.string().max(500).nullable(),
      }),
    )
    .max(5),
});
export type SchedulerResult = z.infer<typeof SchedulerSchema>;

export type EventStatus = "new" | "rescheduled" | "cancelled";

/** One event found in an email (data-model.md "Detected Event"). */
export interface DetectedEvent {
  title: string;
  status: EventStatus;
  source: "invitation" | "ai";
  /** False → shown as "time not set", with no links (FR-116). */
  timeSet: boolean;
  /** ISO instant, or `YYYY-MM-DD` for all-day events; null when the time is not set. */
  start: string | null;
  /** Exclusive end, same format as `start`. */
  end: string | null;
  allDay: boolean;
  /** IANA zone the event was stated in (or the configured zone). */
  timezone: string;
  location: string | null;
  /** https only, shown as written and never fetched. */
  meetingUrl: string | null;
  /** Built by code; null when not set, cancelled or already over (FR-117). */
  links: { google: string; outlook: string } | null;
}

export type ChannelName = "email" | "telegram";

/** At most 5 shown recipients, plus how many more there were. */
export interface RecipientList {
  shown: Address[];
  more: number;
}

/**
 * Channel-neutral result for one important email (contracts/delivery.contract.md and 002
 * contracts/report.contract.md). Fields added in 002 are optional: reports stored by 001 lack them.
 */
export interface Report {
  key: MessageKey;
  source: { accountId: string; label: string };
  original: {
    messageId: string | null;
    from: Address;
    subject: string;
    receivedAt: string;
    to?: RecipientList;
    cc?: RecipientList;
    deliveredTo?: string;
    addressedToYou?: boolean;
    webLink?: string | null;
  };
  kind: "SUMMARY" | "FALLBACK";
  /** Analyst style; absent on 001 reports, which render as detailed. */
  style?: "brief" | "detailed";
  /** The configured time zone, for showing event times. */
  timezone?: string;
  events?: DetectedEvent[];
  /** Events found beyond the 3 shown. */
  eventsOmitted?: number;
  /** Event detection failed; the report says so (constitution III, FR-119). */
  schedulerFailed?: boolean;
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
  /** Estimated AI cost in USD; null when a model had no known price. */
  costUsd: number | null;
  processedAt: string;
}

/** Everything about a record except its final outcome, kept while delivery is pending. */
export type DraftRecord = Omit<ProcessedRecord, "outcome" | "processedAt">;

export interface MailboxState {
  accountId: string;
  mailbox: string;
  /** The source's generation; a change means re-baseline. */
  uidValidity: string;
  /** Opaque, source-defined position of the last settled message. */
  cursor: string;
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
  provider: string;
  model: string;
  ms: number;
  /** Estimated USD cost; null when the model has no known price. */
  costUsd: number | null;
}
