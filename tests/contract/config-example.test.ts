import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";

const example = () =>
  JSON.parse(readFileSync(new URL("../../config.example.json", import.meta.url), "utf8")) as {
    delivery: { telegram: { enabled: boolean } };
  };

const env = {
  OPENAI_API_KEY: "sk-x",
  ANTHROPIC_API_KEY: "sk-ant-x",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  TELEGRAM_BOT_TOKEN: "123456:abc",
};

describe("config.example.json (FR-110, FR-127)", () => {
  it("enables no channel, so the user has to choose one", () => {
    expect(() => parseConfig(example(), env)).toThrow("enable at least one channel");
  });

  it("is valid once a channel is enabled", () => {
    const raw = example();
    raw.delivery.telegram.enabled = true;
    const config = parseConfig(raw, env);
    expect(config.accounts[0]).toMatchObject({ provider: "gmail", auth: "oauth", imap: null });
    expect(config.ai.scheduler).not.toBeNull();
    expect(config.ai.analystStyle).toBe("brief");
  });
});

describe("README documents the example config (FR-110, FR-127)", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

  function keys(value: unknown, out = new Set<string>()): Set<string> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        out.add(k);
        keys(v, out);
      }
    }
    return out;
  }

  it("mentions every key in config.example.json", () => {
    const missing = [...keys(example())].filter((k) => !readme.includes(k));
    expect(missing).toEqual([]);
  });

  it("only mentions app passwords for other providers and the upgrade", () => {
    const sections = readme.split(/\n(?=#{2,4} )/);
    const withAppPassword = sections
      .filter((s) => /app password/i.test(s))
      .map((s) => s.split("\n")[0]);
    for (const heading of withAppPassword) {
      expect(heading).toMatch(
        /Choose your setup|Other providers|sending account|Edit `\.env`|Upgrading from 001|Troubleshooting|Edit `config\.json`/,
      );
    }
    expect(readme).not.toMatch(/Gmail[^\n]*app password[^\n]*(required|create one)/i);
  });
});
