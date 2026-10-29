import type { ZodType } from "zod";
import {
  ChannelError,
  LlmError,
  type Clock,
  type LlmClient,
  type LlmRole,
  type MailSource,
  type MailSourceFactory,
  type RawMessage,
  type ReportChannel,
} from "../../src/domain/ports.js";
import type { ChannelName, LlmUsage, Report } from "../../src/domain/types.js";

// ---------------------------------------------------------------- mail server

interface FakeMailbox {
  uidValidity: number;
  nextUid: number;
  messages: RawMessage[];
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
  ): number {
    const b = this.box(accountId, opts.mailbox ?? "INBOX");
    const uid = b.nextUid++;
    b.messages.push({
      uid,
      source: Buffer.isBuffer(eml) ? eml : Buffer.from(eml),
      internalDate: opts.date ?? new Date(),
    });
    return uid;
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
          return { uidValidity: current.uidValidity, uidNext: current.nextUid };
        },
        fetchSince: (afterUid, limit) => {
          this.fetchCalls.push(accountId);
          const box = current;
          return (async function* () {
            if (!box) throw new Error("mailbox not open");
            yield* box.messages.filter((m) => m.uid > afterUid).slice(0, limit);
          })();
        },
        firstUidSince: async (since) => {
          const m = current?.messages.find((x) => x.internalDate >= since);
          return m ? m.uid : null;
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
  private failures: ChannelError[] = [];
  verifyCalls = 0;

  constructor(readonly name: ChannelName = "email") {}

  /** The next `count` deliveries throw. */
  failNext(count: number, retryable = true, retryAfterMs?: number): void {
    for (let i = 0; i < count; i++) {
      this.failures.push(new ChannelError(`${this.name} down`, retryable, retryAfterMs));
    }
  }

  async deliver(report: Report): Promise<{ externalId: string }> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.delivered.push(report);
    return { externalId: `${this.name}-${this.delivered.length}` };
  }

  async verify(): Promise<void> {
    this.verifyCalls++;
  }
}

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
    };
  }

  callsFor(role: LlmRole): number {
    return this.calls.filter((c) => c.role === role).length;
  }

  async generate<T>(
    role: LlmRole,
    args: { system: string; user: string; schema: ZodType<T> },
  ): Promise<{ value: T; usage: LlmUsage }> {
    this.calls.push({ role, system: args.system, user: args.user });
    const raw = this.handlers[role](args);
    const parsed = args.schema.safeParse(raw);
    if (!parsed.success) throw new LlmError(`invalid ${role} output`);
    return { value: parsed.data, usage: { input: 100, output: 20 } };
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
