import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../../src/config/address.js";
import { ConfigError, parseConfig } from "../../src/config/load.js";
import { rawConfig, testEnv } from "../fakes/config.js";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form test mutation

function parse(mutate: (raw: Raw) => void) {
  const raw = rawConfig() as Raw;
  mutate(raw);
  return () => parseConfig(raw, testEnv);
}

function withMonitored(email: string, to: string) {
  return parse((c) => {
    c.accounts.push({
      id: "personal",
      email,
      imap: { host: "imap.gmail.com", user: email, password_env: "SCHOOL_IMAP_PASSWORD" },
    });
    c.delivery.email.to = to;
  });
}

describe("normalizeAddress", () => {
  it.each([
    ["Me@Example.com", "me@example.com"],
    ["me+reports@example.com", "me@example.com"],
    ["first.last@gmail.com", "firstlast@gmail.com"],
    ["First.Last+x@GoogleMail.com", "firstlast@gmail.com"],
    ["first.last@example.com", "first.last@example.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });
});

describe("delivery config (FR-020, FR-021)", () => {
  it("accepts a report address that is not monitored", () => {
    expect(withMonitored("me@gmail.com", "other@gmail.com")).not.toThrow();
  });

  it.each([
    ["the same address", "me@gmail.com", "me@gmail.com"],
    ["a different case", "me@gmail.com", "ME@Gmail.com"],
    ["a +tag", "me@gmail.com", "me+reports@gmail.com"],
    ["Gmail dots", "first.last@gmail.com", "firstlast@gmail.com"],
    ["the googlemail alias", "me@gmail.com", "m.e@googlemail.com"],
  ])("rejects %s", (_name, monitored, to) => {
    const run = withMonitored(monitored, to);
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(
      `Invalid config: delivery.email.to — "${to}" is also monitored by accounts[1] ("personal"). Reports would be read back in. Use an address that is not monitored.`,
    );
  });

  it("also compares against the IMAP login", () => {
    const run = parse((c) => {
      c.accounts[0].imap.user = "login@primary.example";
      c.delivery.email.to = "Login@primary.example";
    });
    expect(run).toThrow(/delivery\.email\.to — .* accounts\[0\] \("school"\)/);
  });

  it("does not check the address when the email channel is disabled", () => {
    const run = parse((c) => {
      c.delivery.email = { enabled: false, to: "student@university.edu" };
      c.delivery.telegram = { enabled: true, bot_token_env: "TELEGRAM_BOT_TOKEN", chat_id: "42" };
    });
    expect(run).not.toThrow();
  });

  it("rejects a config with no channel enabled", () => {
    const run = parse((c) => {
      c.delivery = { email: { enabled: false } };
    });
    expect(run).toThrow(
      "Invalid config: delivery — enable at least one channel: set delivery.email.enabled or delivery.telegram.enabled to true",
    );
  });

  it("accepts Telegram alone and resolves its token", () => {
    const cfg = parse((c) => {
      c.delivery = {
        telegram: { enabled: true, bot_token_env: "TELEGRAM_BOT_TOKEN", chat_id: "-100123" },
      };
    })();
    expect(cfg.delivery.email).toBeNull();
    expect(cfg.delivery.telegram).toEqual({
      botToken: testEnv.TELEGRAM_BOT_TOKEN,
      chatId: "-100123",
    });
    expect(cfg.secrets).toContain(testEnv.TELEGRAM_BOT_TOKEN);
  });

  it("rejects an enabled Telegram channel without a chat id", () => {
    const run = parse((c) => {
      c.delivery.telegram = { enabled: true, bot_token_env: "TELEGRAM_BOT_TOKEN" };
    });
    expect(run).toThrow("Invalid config: delivery.telegram.chat_id — required when enabled");
  });

  it("rejects a malformed chat id", () => {
    const run = parse((c) => {
      c.delivery.telegram = { enabled: true, bot_token_env: "TELEGRAM_BOT_TOKEN", chat_id: "me" };
    });
    expect(run).toThrow(/delivery\.telegram\.chat_id — must be a numeric chat ID or @channelname/);
  });

  it("rejects a Telegram token that is not in bot-token format", () => {
    const run = () =>
      parseConfig(
        {
          ...rawConfig(),
          delivery: {
            telegram: { enabled: true, bot_token_env: "TELEGRAM_BOT_TOKEN", chat_id: "1" },
          },
        },
        { ...testEnv, TELEGRAM_BOT_TOKEN: "not-a-token" },
      );
    expect(run).toThrow(/delivery\.telegram\.bot_token_env — .*not a Telegram bot token/);
  });
});

describe("channel choice (US6, FR-125–126)", () => {
  const telegram = { enabled: true, bot_token_env: "TELEGRAM_BOT_TOKEN", chat_id: "123456789" };

  it.each([
    ["email only", (c: Raw) => void c],
    ["telegram only", (c: Raw) => (c.delivery = { telegram })],
    ["both", (c: Raw) => (c.delivery.telegram = telegram)],
  ])("accepts %s", (_name, mutate) => {
    expect(parse(mutate)).not.toThrow();
  });

  it("ignores incomplete settings of a disabled channel", () => {
    const run = parse((c) => {
      c.delivery = { email: { enabled: false, smtp: { user: "x" } }, telegram };
    });
    expect(run).not.toThrow();
  });

  it("needs no sending secret for a Telegram-only setup", () => {
    const raw = rawConfig() as Raw;
    raw.delivery = { telegram };
    const env: Record<string, string> = { ...testEnv };
    delete env.SMTP_PASSWORD;
    const cfg = parseConfig(raw, env);
    expect(cfg.delivery.email).toBeNull();
    expect(cfg.secrets).not.toContain(testEnv.SMTP_PASSWORD);
  });

  it("rejects an email channel with both or neither sending account", () => {
    const both = parse((c) => {
      c.delivery.email.oauth = { provider: "gmail", user: "me@gmail.com" };
    });
    expect(both).toThrow('delivery.email — set exactly one sending account: "oauth"');
  });
});
