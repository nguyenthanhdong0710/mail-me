import type { ZodType } from "zod";
import type {
  ChannelName,
  DeliveryRow,
  DraftRecord,
  LlmUsage,
  MailboxState,
  MessageKey,
  PendingReport,
  ProcessedRecord,
  Report,
} from "./types.js";

// Ports at the IO edges (contracts/ports.contract.md). Production adapters live next to
// their module; fakes live in tests/fakes/.

export interface RawMessage {
  uid: number;
  source: Buffer;
  internalDate: Date;
}

/** One connection to one account. Mailboxes are always opened read-only (FR-013). */
export interface MailSource {
  open(mailbox: string): Promise<{ uidValidity: number; uidNext: number }>;
  /** Messages with UID > afterUid, ascending, without setting \Seen. */
  fetchSince(afterUid: number, limit: number): AsyncIterable<RawMessage>;
  /** Lowest UID received on or after `since`, or null if none. */
  firstUidSince(since: Date): Promise<number | null>;
  close(): Promise<void>;
}

export type MailSourceFactory = (accountId: string) => MailSource;

export type LlmRole = "gatekeeper" | "analyst";

export interface LlmClient {
  /** Returns a schema-validated object or throws LlmError. */
  generate<T>(
    role: LlmRole,
    args: { system: string; user: string; schema: ZodType<T> },
  ): Promise<{ value: T; usage: LlmUsage }>;
}

export class LlmError extends Error {
  override name = "LlmError";
}

/** Where a multi-part delivery (Telegram split) left off; parts before it are not re-sent. */
export interface DeliveryProgress {
  partsSent: number;
}

export interface ReportChannel {
  readonly name: ChannelName;
  deliver(report: Report, progress?: DeliveryProgress): Promise<{ externalId: string }>;
  verify(): Promise<void>;
}

export class ChannelError extends Error {
  override name = "ChannelError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    /** Parts delivered before the failure, for channels that split a report. */
    readonly partsSent?: number,
  ) {
    super(message);
  }
}

/** Thin HTTP seam used by the Telegram channel so tests can fake the Bot API. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Store {
  getMailboxState(accountId: string, mailbox: string): MailboxState | null;
  setMailboxState(state: MailboxState): void;
  isProcessed(key: MessageKey, messageId: string | null): boolean;
  hasPendingReport(key: MessageKey): boolean;
  /** Idempotent. */
  recordProcessed(record: ProcessedRecord): void;
  purgeOlderThan(days: number, now: Date): number;
  savePendingReport(report: Report, draft: DraftRecord, channels: ChannelName[]): void;
  listPendingReports(accountId?: string): PendingReport[];
  updateDelivery(row: DeliveryRow): void;
  /** One transaction: write the processed record and drop the pending report. */
  completeReport(record: ProcessedRecord): void;
  getInstallId(): string;
  close(): void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
