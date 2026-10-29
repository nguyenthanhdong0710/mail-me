import type { ZodType } from "zod";
import type { Logger } from "../lib/logger.js";
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
  /** IMAP UID, Gmail message ID or Graph immutable ID. */
  id: string;
  /** Persist once this and every earlier message are settled (002 research R2). */
  cursor: string;
  source: Buffer;
  internalDate: Date;
  /** Provider-supplied link to the message in webmail (Graph `webLink`). */
  webLink?: string;
}

/**
 * One connection to one account (contracts/mail-access.contract.md). Never changes anything in
 * the mailbox (FR-013, FR-109).
 */
export interface MailSource {
  /** `generation` plays the role of UIDVALIDITY; `head` is the cursor for "now". */
  open(mailbox: string): Promise<{ generation: string; head: string }>;
  /** Messages after `cursor`, oldest first, at most `limit`. */
  fetchSince(cursor: string, limit: number): AsyncIterable<RawMessage>;
  /** Cursor that makes fetchSince start at mail received on/after `since`, or null if none. */
  cursorSince(since: Date): Promise<string | null>;
  /**
   * Optional: after fetchSince ran to the end with every message settled, a newer cursor to
   * persist even if no message arrived (Gmail history IDs expire when the cursor sits still).
   */
  settledCursor?(): string | null;
  close(): Promise<void>;
}

export type MailSourceFactory = (accountId: string) => MailSource;

export type LlmRole = "gatekeeper" | "analyst" | "scheduler";

export interface LlmClient {
  /** Returns a schema-validated object or throws LlmError. */
  generate<T>(
    role: LlmRole,
    args: {
      system: string;
      user: string;
      schema: ZodType<T>;
      /** Child logger carrying the email's context, for the per-call `ai call` line. */
      log?: Logger;
    },
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

// ---------------------------------------------------------------- OAuth (002)

export type OAuthProvider = "google" | "microsoft";
export type GrantPurpose = "read" | "send";

/** A stored OAuth grant (data-model.md "OAuth Grant"). Secret: never log it. */
export interface Grant {
  version: 1;
  provider: OAuthProvider;
  purpose: GrantPurpose;
  address: string;
  scopes: string[];
  clientId: string;
  tenant?: string;
  refreshToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface GrantStore {
  /** Null when the grant file does not exist; throws on a bad file. */
  read(name: string): Grant | null;
  /** Atomic, owner-only. */
  write(name: string, grant: Grant): void;
}

export interface TokenProvider {
  /** A valid access token; refreshes (and persists a rotated refresh token) when needed. */
  accessToken(): Promise<string>;
  /** Drop the cached access token, e.g. after a 401. */
  invalidate(): void;
}

/** The grant was revoked or expired; the user must sign in again. */
export class GrantRevokedError extends Error {
  override name = "GrantRevokedError";
  constructor(
    readonly grantName: string,
    readonly fixCommand: string,
    detail?: string,
  ) {
    super(
      `sign-in revoked or expired for "${grantName}"${detail ? ` (${detail})` : ""}, run: ${fixCommand}`,
    );
  }
}

/** Terminal IO used by interactive sign-in. */
export interface SignInIO {
  print(line: string): void;
  /** Resolves with one pasted line, or never if stdin is closed. */
  readLine(): Promise<string>;
}

export interface OAuthClient {
  readonly provider: OAuthProvider;
  /** Interactive sign-in; resolves with the confirmed address and granted scopes. */
  signIn(purpose: GrantPurpose, io: SignInIO): Promise<Grant>;
  refresh(grant: Grant): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }>;
}

/** Sends one complete MIME message for the email channel. */
export interface MailSender {
  /** Throws ChannelError (retryable or not). */
  send(
    mime: Buffer,
    envelope: { from: string; to: string; messageId?: string },
  ): Promise<{ externalId: string }>;
  verify(): Promise<void>;
}
