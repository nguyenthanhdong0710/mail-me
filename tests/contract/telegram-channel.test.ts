import { describe, expect, it } from "vitest";
import {
  findChats,
  TelegramBotApi,
  TelegramChannel,
} from "../../src/courier/channels/telegram/telegram-channel.js";
import { ChannelError } from "../../src/domain/ports.js";
import { createLogger } from "../../src/lib/logger.js";
import { analysis, FakeHttpFetch, sampleReport, telegramError } from "../fakes/index.js";

const TOKEN = "123456:SECRET-token_abc";
const cfg = { botToken: TOKEN, chatId: "42" };

function channel(http: FakeHttpFetch, opts: { minIntervalMs?: number; sleeps?: number[] } = {}) {
  let clock = 0;
  return new TelegramChannel(cfg, {
    fetch: http.fetch,
    minIntervalMs: opts.minIntervalMs ?? 0,
    now: () => clock,
    sleep: async (ms) => {
      opts.sleeps?.push(ms);
      clock += ms;
    },
  });
}

async function caught(p: Promise<unknown>): Promise<ChannelError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ChannelError);
    return err as ChannelError;
  }
  throw new Error("expected a ChannelError");
}

const longReport = () =>
  sampleReport({
    analysis: analysis({
      summary: "S".repeat(1000),
      key_points: Array.from({ length: 10 }, () => "p".repeat(500)),
    }) as never,
  });

describe("TelegramChannel.deliver", () => {
  it("posts sendMessage with HTML parse mode and no link previews", async () => {
    const http = new FakeHttpFetch();
    const { externalId } = await channel(http).deliver(sampleReport());

    const [call] = http.calls;
    expect(call!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(call!.body).toMatchObject({
      chat_id: "42",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(call!.body.text).toContain("[AI Summary] Assignment 3");
    expect(externalId).toBe("100");
  });

  it("sends every part of a split report and returns the first message id", async () => {
    const http = new FakeHttpFetch();
    const { externalId } = await channel(http).deliver(longReport());
    const sent = http.callsTo("sendMessage");
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.body.text).toMatch(/^\(1\/\d\)/);
    expect(externalId).toBe("100");
  });

  it("reports progress on a mid-way failure and resumes from there", async () => {
    const http = new FakeHttpFetch().reply(
      "sendMessage",
      { json: { ok: true, result: { message_id: 1 } } },
      telegramError(502, "Bad Gateway"),
    );
    const ch = channel(http);
    const err = await caught(ch.deliver(longReport()));
    expect(err.retryable).toBe(true);
    expect(err.partsSent).toBe(1);

    const total = http.callsTo("sendMessage").length; // 2 so far
    await ch.deliver(longReport(), { partsSent: 1 });
    const resent = http.callsTo("sendMessage").slice(total);
    expect(resent[0]!.body.text).toMatch(/^\(2\//); // part 1 is not sent again
  });

  it("maps 429 to a retryable error with retryAfterMs", async () => {
    const http = new FakeHttpFetch().reply(
      "sendMessage",
      telegramError(429, "Too Many Requests: retry after 7", 7),
    );
    const err = await caught(channel(http).deliver(sampleReport()));
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(7000);
  });

  it.each([
    [400, "Bad Request: chat not found"],
    [401, "Unauthorized"],
    [403, "Forbidden: bot was blocked by the user"],
  ])("maps %i to a non-retryable error", async (status, description) => {
    const http = new FakeHttpFetch().reply("sendMessage", telegramError(status, description));
    const err = await caught(channel(http).deliver(sampleReport()));
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(description);
  });

  it("treats 5xx and network errors as retryable", async () => {
    const http = new FakeHttpFetch().reply(
      "sendMessage",
      telegramError(500, "Internal"),
      new Error("ECONNRESET"),
    );
    const ch = channel(http);
    expect((await caught(ch.deliver(sampleReport()))).retryable).toBe(true);
    expect((await caught(ch.deliver(sampleReport()))).retryable).toBe(true);
  });

  it("handles a non-JSON error body", async () => {
    const http = new FakeHttpFetch();
    http.fetch = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const err = await caught(channel(http).deliver(sampleReport()));
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("502");
  });

  it("never puts the token in an error or a log line", async () => {
    const http = new FakeHttpFetch().reply(
      "sendMessage",
      new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`),
      telegramError(401, `Unauthorized for ${TOKEN}`),
    );
    const ch = channel(http);
    const errors = [
      await caught(ch.deliver(sampleReport())),
      await caught(ch.deliver(sampleReport())),
    ];

    const lines: string[] = [];
    const logger = createLogger({ secrets: [] }, { write: (s: string) => void lines.push(s) });
    for (const err of errors) {
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).toContain("[REDACTED]");
      logger.error({ err: err.message, stack: err.stack }, "delivery failed");
    }
    expect(lines.join("")).not.toContain(TOKEN);
  });

  it("spaces messages to the chat at least minIntervalMs apart", async () => {
    const sleeps: number[] = [];
    const http = new FakeHttpFetch();
    await channel(http, { minIntervalMs: 1000, sleeps }).deliver(longReport());
    const parts = http.callsTo("sendMessage").length;
    expect(sleeps).toHaveLength(parts - 1);
    sleeps.forEach((ms) => expect(ms).toBe(1000));
  });
});

describe("TelegramChannel.verify", () => {
  it("checks the token with getMe and the chat with getChat", async () => {
    const http = new FakeHttpFetch();
    await channel(http).verify();
    expect(http.calls.map((c) => c.method)).toEqual(["getMe", "getChat"]);
    expect(http.callsTo("getChat")[0]!.body).toEqual({ chat_id: "42" });
  });

  it("fails on a bad token", async () => {
    const http = new FakeHttpFetch().reply("getMe", telegramError(401, "Unauthorized"));
    const err = await caught(channel(http).verify());
    expect(err.message).toContain("Unauthorized");
    expect(http.callsTo("getChat")).toHaveLength(0);
  });

  it("tells the user to send /start when the chat is unreachable", async () => {
    const http = new FakeHttpFetch().reply(
      "getChat",
      telegramError(400, "Bad Request: chat not found"),
    );
    const err = await caught(channel(http).verify());
    expect(err.message).toContain("chat not found");
    expect(err.message).toContain("/start");
  });
});

describe("findChats", () => {
  it("lists unique chats from getUpdates", async () => {
    const http = new FakeHttpFetch().reply("getUpdates", {
      json: {
        ok: true,
        result: [
          { message: { chat: { id: 42, type: "private", first_name: "Alex", last_name: "Doe" } } },
          { message: { chat: { id: 42, type: "private", first_name: "Alex" } } },
          { my_chat_member: { chat: { id: -100123, type: "supergroup", title: "Family" } } },
          { channel_post: { chat: { id: -100999, type: "channel", username: "news" } } },
        ],
      },
    });
    const chats = await findChats(new TelegramBotApi(TOKEN, { fetch: http.fetch }));
    expect(chats).toEqual([
      { id: 42, type: "private", name: "Alex Doe" },
      { id: -100123, type: "supergroup", name: "Family" },
      { id: -100999, type: "channel", name: "@news" },
    ]);
  });
});
