import type { ZodType } from "zod";
import {
  ChannelError,
  LlmError,
  type Clock,
  type DeliveryProgress,
  type HttpFetch,
  type LlmClient,
  type LlmRole,
  type MailSource,
  type MailSourceFactory,
  type RawMessage,
  type ReportChannel,
} from "../../src/domain/ports.js";
import type { ChannelName, LlmUsage, Report } from "../../src/domain/types.js";

// ---------------------------------------------------------------- mail server

interface FakeMessage {
  uid: number;
  source: Buffer;
  internalDate: Date;
}

interface FakeMailbox {
  uidValidity: number;
  nextUid: number;
  messages: FakeMessage[];
}

/** In-memory IMAP stand-in shared by every FakeMailSource it creates. */
export class FakeMailServer {
  private readonly boxes = new Map<string, FakeMailbox>();
  readonly openFailures = new Map<string, Error>();
  /** Count of fetches per account, to assert read-only behaviour is the only access. */
  readonly fetchCalls: string[] = [];

  private box(accountId: string, mailbox: string): FakeMailbox {
    const id = `${accountId}/${mailbox}`;
    let b = this.boxes.get(id);
    if (!b) {
      b = { uidValidity: 1, nextUid: 1, messages: [] };
      this.boxes.set(id, b);
    }
    return b;
  }

  deliver(
    accountId: string,
    eml: string | Buffer,
    opts: { mailbox?: string; date?: Date } = {},
  ): string {
    const b = this.box(accountId, opts.mailbox ?? "INBOX");
    const uid = b.nextUid++;
    b.messages.push({
      uid,
      source: Buffer.isBuffer(eml) ? eml : Buffer.from(eml),
      internalDate: opts.date ?? new Date(),
    });
    return String(uid);
  }

  /** Simulates a server-side UIDVALIDITY reset: same messages, new UIDs. */
  resetUidValidity(accountId: string, mailbox = "INBOX"): void {
    const b = this.box(accountId, mailbox);
    b.uidValidity += 1;
    b.messages = b.messages.map((m, i) => ({ ...m, uid: i + 1 }));
    b.nextUid = b.messages.length + 1;
  }

  factory(): MailSourceFactory {
    return (accountId: string): MailSource => {
      let current: FakeMailbox | null = null;
      return {
        open: async (mailbox) => {
          const failure = this.openFailures.get(accountId);
          if (failure) throw failure;
          current = this.box(accountId, mailbox);
          return { generation: String(current.uidValidity), head: String(current.nextUid - 1) };
        },
        fetchSince: (cursor, limit) => {
          this.fetchCalls.push(accountId);
          const box = current;
          const afterUid = Number(cursor);
          return (async function* (): AsyncGenerator<RawMessage> {
            if (!box) throw new Error("mailbox not open");
            for (const m of box.messages.filter((x) => x.uid > afterUid).slice(0, limit)) {
              const id = String(m.uid);
              yield { id, cursor: id, source: m.source, internalDate: m.internalDate };
            }
          })();
        },
        cursorSince: async (since) => {
          const m = current?.messages.find((x) => x.internalDate >= since);
          return m ? String(m.uid - 1) : null;
        },
        close: async () => {
          current = null;
        },
      };
    };
  }
}

// ---------------------------------------------------------------- channel

export class FakeChannel implements ReportChannel {
  readonly delivered: Report[] = [];
  readonly progress: Array<DeliveryProgress | undefined> = [];
  private failures: ChannelError[] = [];
  verifyCalls = 0;

  constructor(readonly name: ChannelName = "email") {}

  /** The next `count` deliveries throw. */
  failNext(count: number, retryable = true, retryAfterMs?: number): void {
    for (let i = 0; i < count; i++) {
      this.failures.push(new ChannelError(`${this.name} down`, retryable, retryAfterMs));
    }
  }

  async deliver(report: Report, progress?: DeliveryProgress): Promise<{ externalId: string }> {
    this.progress.push(progress);
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.delivered.push(report);
    return { externalId: `${this.name}-${this.delivered.length}` };
  }

  async verify(): Promise<void> {
    this.verifyCalls++;
  }
}

// ---------------------------------------------------------------- http (Telegram Bot API)

export interface FakeHttpCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

type HttpReply = { status?: number; json: unknown } | Error;

/**
 * Scripted `fetch`. Replies are matched by Bot API method name (the last URL segment);
 * queued replies are used first, then the default for that method, then `{ ok: true }`.
 */
export class FakeHttpFetch {
  readonly calls: FakeHttpCall[] = [];
  private readonly queued = new Map<string, HttpReply[]>();
  private readonly defaults = new Map<string, HttpReply>();
  private nextMessageId = 100;

  /** Queue one-off replies for `method`. */
  reply(method: string, ...replies: HttpReply[]): this {
    this.queued.set(method, [...(this.queued.get(method) ?? []), ...replies]);
    return this;
  }

  /** Reply used for every call to `method` once the queue is empty. */
  always(method: string, reply: HttpReply): this {
    this.defaults.set(method, reply);
    return this;
  }

  callsTo(method: string): FakeHttpCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  fetch: HttpFetch = async (url, init) => {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    this.calls.push({ url, method, body });
    const reply = this.queued.get(method)?.shift() ??
      this.defaults.get(method) ?? {
        json: {
          ok: true,
          result: method === "sendMessage" ? { message_id: this.nextMessageId++ } : true,
        },
      };
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

export const telegramError = (status: number, description: string, retryAfter?: number) => ({
  status,
  json: {
    ok: false,
    error_code: status,
    description,
    ...(retryAfter !== undefined && { parameters: { retry_after: retryAfter } }),
  },
});

// ---------------------------------------------------------------- llm

type LlmHandler = (args: { system: string; user: string }) => unknown;

/**
 * Scripted LLM. Each role has a handler returning the raw object (validated against
 * the caller's schema, like the real adapter) or throwing to simulate a provider error.
 */
export class FakeLlm implements LlmClient {
  readonly calls: Array<{ role: LlmRole; system: string; user: string }> = [];
  handlers: Record<LlmRole, LlmHandler>;

  constructor(handlers: Partial<Record<LlmRole, LlmHandler>> = {}) {
    this.handlers = {
      gatekeeper: handlers.gatekeeper ?? (() => important()),
      analyst: handlers.analyst ?? (() => analysis()),
      scheduler: handlers.scheduler ?? (() => ({ events: [] })),
    };
  }

  callsFor(role: LlmRole): number {
    return this.calls.filter((c) => c.role === role).length;
  }

  /** Usage returned for every call; tests change it to check cost totals. */
  usage: Omit<LlmUsage, "model"> & { model?: string } = {
    input: 100,
    output: 20,
    provider: "openai",
    ms: 5,
    costUsd: 0.0001,
  };

  async generate<T>(
    role: LlmRole,
    args: { system: string; user: string; schema: ZodType<T> },
  ): Promise<{ value: T; usage: LlmUsage }> {
    this.calls.push({ role, system: args.system, user: args.user });
    const raw = this.handlers[role](args);
    const parsed = args.schema.safeParse(raw);
    if (!parsed.success) throw new LlmError(`invalid ${role} output`);
    return { value: parsed.data, usage: { model: `${role}-model`, ...this.usage } };
  }
}

export const important = (confidence = 0.95) => ({
  category: "IMPORTANT",
  confidence_score: confidence,
  reasoning: "Direct message with a deadline",
});

export const promotion = (confidence = 0.95) => ({
  category: "PROMOTION",
  confidence_score: confidence,
  reasoning: "Marketing newsletter",
});

export const analysis = (overrides: Record<string, unknown> = {}) => ({
  original_language: "English",
  summary: "Bài tập 3 phải nộp trước 17:00 thứ Sáu qua cổng thông tin.",
  key_points: ["Bài tập 3 đã được giao", "Nộp qua cổng thông tin"],
  action_items: [{ action: "Nộp bài tập 3", deadline: "Thứ Sáu 17:00" }],
  requires_immediate_attention: false,
  ...overrides,
});

// ---------------------------------------------------------------- clock

export class FakeClock implements Clock {
  constructor(private current = new Date("2026-10-29T08:00:00Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

// ---------------------------------------------------------------- report

export function sampleReport(overrides: Partial<Report> = {}): Report {
  return {
    key: { accountId: "school", mailbox: "INBOX", uidValidity: "1", uid: "5" },
    source: { accountId: "school", label: "School" },
    original: {
      messageId: "<orig@university.edu>",
      from: { name: "Prof. Nguyen", address: "prof@university.edu" },
      subject: "Assignment 3",
      receivedAt: "2026-10-28T02:15:00.000Z",
    },
    kind: "SUMMARY",
    analysis: analysis() as Report["analysis"],
    excerpt: "Please submit before Friday 5pm.",
    truncated: false,
    urgent: false,
    actionNeeded: true,
    ...overrides,
  };
}
