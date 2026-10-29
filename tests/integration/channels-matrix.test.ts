import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { buildChannels } from "../../src/courier/channels/index.js";
import { TelegramChannel } from "../../src/courier/channels/telegram/telegram-channel.js";
import { rawConfig } from "../fakes/config.js";
import { FakeHttpFetch, sampleReport } from "../fakes/index.js";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test mutation

const env = {
  SCHOOL_IMAP_PASSWORD: "imap",
  OPENAI_API_KEY: "sk-o",
  ANTHROPIC_API_KEY: "sk-a",
  TELEGRAM_BOT_TOKEN: "123456:telegram-secret",
};

function config(mutate: (raw: Raw) => void) {
  const raw = rawConfig() as Raw;
  mutate(raw);
  return parseConfig(raw, env);
}

const telegram = { enabled: true, bot_token_env: "TELEGRAM_BOT_TOKEN", chat_id: "123456789" };

describe("delivery channel combinations (US6)", () => {
  it("runs Telegram-only with no sending account or SMTP secret (SC-110)", async () => {
    const cfg = config((c) => (c.delivery = { telegram }));
    const channels = buildChannels(cfg, "install");
    expect([...channels.keys()]).toEqual(["telegram"]);

    const http = new FakeHttpFetch();
    const channel = new TelegramChannel(cfg.delivery.telegram!, {
      fetch: http.fetch,
      sleep: async () => {},
    });
    await channel.deliver(sampleReport());
    expect(http.callsTo("sendMessage")).toHaveLength(1);
  });

  it("builds only the email channel for an email-only setup", () => {
    const cfg = config((c) => {
      c.delivery.email.smtp.password_env = "OPENAI_API_KEY";
    });
    expect([...buildChannels(cfg, "install").keys()]).toEqual(["email"]);
  });

  it("builds both channels when both are enabled", () => {
    const cfg = config((c) => {
      c.delivery.email.smtp.password_env = "OPENAI_API_KEY";
      c.delivery.telegram = telegram;
    });
    expect([...buildChannels(cfg, "install").keys()].sort()).toEqual(["email", "telegram"]);
  });
});
