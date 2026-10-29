# Contract: Internal Ports (adapters at the IO edges)

```ts
interface MailSource {
  /** Opens the mailbox read-only and returns its identity and current max UID. */
  open(accountId: string, mailbox: string): Promise<{ uidValidity: number; uidNext: number }>;
  /** Fetches messages with UID > afterUid in ascending order, without setting \Seen. */
  fetchSince(afterUid: number, limit: number): AsyncIterable<RawMessage>; // { uid, source: Buffer, internalDate }
  close(): Promise<void>;
}

/** Report delivery: one implementation per channel (email, telegram). See delivery.contract.md. */
interface ReportChannel {
  readonly name: "email" | "telegram";
  deliver(report: Report): Promise<{ externalId: string }>;
  verify(): Promise<void>;
}

/** Thin HTTP seam used by the Telegram channel so tests can fake the Bot API. */
type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

interface LlmClient {
  /** Returns a schema-validated object or throws LlmError. */
  generate<T>(role: "gatekeeper" | "analyst", args: { system: string; user: string; schema: ZodType<T> }):
    Promise<{ value: T; usage: { input: number; output: number } }>;
}

interface Store {
  getMailboxState(accountId: string, mailbox: string): MailboxState | null;
  setMailboxState(s: MailboxState): void;
  isProcessed(key: { accountId: string; uidValidity: number; uid: number; messageId: string | null }): boolean;
  recordProcessed(r: ProcessedRecord): void; // idempotent (INSERT OR IGNORE)
  purgeOlderThan(days: number): number;
  // Delivery tracking (FR-024)
  savePendingReport(report: Report, channels: string[]): void;   // creates PENDING delivery rows
  listPendingReports(): Array<{ report: Report; deliveries: DeliveryRow[] }>;
  updateDelivery(row: DeliveryRow): void;
  completeReport(key: MessageKey, record: ProcessedRecord): void; // one transaction: record + delete pending
  getInstallId(): string;                                         // self-sent marker id
}

interface Clock { now(): Date }
```

Each port has a production adapter (`imapflow`, `nodemailer` email channel, Telegram Bot API channel over `fetch`, AI SDK, `better-sqlite3`) and a test fake in `tests/fakes/`.

`RawMessage` also exposes the parsed headers that the self-sent check needs (`X-Mail-Me`, `Auto-Submitted`).
