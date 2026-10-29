import type { TelegramChannelConfig } from "../../../config/load.js";
import {
  ChannelError,
  type DeliveryProgress,
  type HttpFetch,
  type ReportChannel,
} from "../../../domain/ports.js";
import type { Report } from "../../../domain/types.js";
import { sleep as realSleep } from "../../../lib/retry.js";
import { renderTelegram } from "./render.js";

const API_BASE = "https://api.telegram.org";

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramChannelOptions {
  fetch?: HttpFetch;
  /** Minimum gap between messages to the same chat; bots get about 1 msg/s (research R14). */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  apiBase?: string;
}

/**
 * Minimal Bot API client over `fetch`. The token is part of every URL, so it is scrubbed from
 * every error message this module produces.
 */
export class TelegramBotApi {
  private readonly fetch: HttpFetch;
  private readonly apiBase: string;

  constructor(
    private readonly token: string,
    opts: Pick<TelegramChannelOptions, "fetch" | "apiBase"> = {},
  ) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.apiBase = opts.apiBase ?? API_BASE;
  }

  redact(text: string): string {
    return this.token ? text.split(this.token).join("[REDACTED]") : text;
  }

  async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ChannelError(this.redact(`telegram ${method}: ${(err as Error).message}`), true);
    }

    let data: BotApiResponse<T> | null = null;
    try {
      data = (await res.json()) as BotApiResponse<T>;
    } catch {
      // Non-JSON body (proxy error page etc.): classify by HTTP status below.
    }
    if (res.ok && data?.ok) return data.result as T;

    const code = data?.error_code ?? res.status;
    const description = this.redact(data?.description ?? `HTTP ${res.status}`);
    const message = `telegram ${method}: ${code} ${description}`;
    if (code === 429) {
      const after = data?.parameters?.retry_after;
      throw new ChannelError(message, true, after !== undefined ? after * 1000 : undefined);
    }
    // 400 chat not found, 401 bad token, 403 bot blocked: retrying will not help.
    throw new ChannelError(message, code >= 500);
  }
}

export class TelegramChannel implements ReportChannel {
  readonly name = "telegram" as const;
  private readonly api: TelegramBotApi;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastSentAt = -Infinity;
  private slot: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: TelegramChannelConfig,
    opts: TelegramChannelOptions = {},
  ) {
    this.api = new TelegramBotApi(cfg.botToken, opts);
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Serializes sends to the chat and spaces them `minIntervalMs` apart. */
  private throttle(): Promise<void> {
    const turn = this.slot.then(async () => {
      const wait = this.lastSentAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastSentAt = this.now();
    });
    this.slot = turn.catch(() => {});
    return turn;
  }

  async send(text: string): Promise<{ message_id: number }> {
    await this.throttle();
    return this.api.call<{ message_id: number }>("sendMessage", {
      chat_id: this.cfg.chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }

  /**
   * Sends every part from `progress.partsSent` on. If a part fails, the error carries how many
   * parts are done, so the next attempt resumes there instead of repeating earlier parts.
   */
  async deliver(report: Report, progress?: DeliveryProgress): Promise<{ externalId: string }> {
    const parts = renderTelegram(report);
    let firstId: string | null = null;
    for (let i = progress?.partsSent ?? 0; i < parts.length; i++) {
      try {
        const msg = await this.send(parts[i]!);
        firstId ??= String(msg.message_id);
      } catch (err) {
        const ce = err instanceof ChannelError ? err : new ChannelError(String(err), true);
        throw new ChannelError(ce.message, ce.retryable, ce.retryAfterMs, i);
      }
    }
    return { externalId: firstId ?? "" };
  }

  async verify(): Promise<void> {
    await this.api.call("getMe");
    try {
      await this.api.call("getChat", { chat_id: this.cfg.chatId });
    } catch (err) {
      const ce = err as ChannelError;
      throw new ChannelError(
        `${ce.message}. The bot cannot reach chat ${this.cfg.chatId}: open your bot in Telegram and send it /start first.`,
        ce.retryable,
      );
    }
  }
}

export interface TelegramChat {
  id: number;
  type: string;
  name: string;
}

interface Update {
  message?: { chat: RawChat };
  channel_post?: { chat: RawChat };
  my_chat_member?: { chat: RawChat };
}
interface RawChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** Chats that recently messaged the bot, for the `telegram-chat-id` setup helper. */
export async function findChats(api: TelegramBotApi): Promise<TelegramChat[]> {
  const updates = await api.call<Update[]>("getUpdates", { timeout: 0 });
  const chats = new Map<number, TelegramChat>();
  for (const u of updates) {
    const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (!chat || chats.has(chat.id)) continue;
    const name =
      chat.title ??
      ([chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
        (chat.username ? `@${chat.username}` : ""));
    chats.set(chat.id, { id: chat.id, type: chat.type, name });
  }
  return [...chats.values()];
}
