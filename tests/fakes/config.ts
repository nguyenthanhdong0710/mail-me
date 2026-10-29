import { parseConfig, type AppConfig } from "../../src/config/load.js";

export const testEnv = {
  SCHOOL_IMAP_PASSWORD: "imap-secret-123",
  SMTP_PASSWORD: "smtp-secret-456",
  OPENAI_API_KEY: "sk-openai-secret-789",
  ANTHROPIC_API_KEY: "sk-ant-secret-000",
  TELEGRAM_BOT_TOKEN: "123456:telegram-secret",
};

/** A minimal valid raw config (as it would appear in config.json). */
export function rawConfig(): Record<string, unknown> {
  return {
    accounts: [
      {
        id: "school",
        label: "School",
        email: "student@university.edu",
        imap: {
          host: "imap.example.com",
          user: "student@university.edu",
          password_env: "SCHOOL_IMAP_PASSWORD",
        },
      },
    ],
    delivery: {
      email: {
        enabled: true,
        to: "me@primary.example",
        smtp: {
          host: "smtp.example.com",
          user: "me@primary.example",
          password_env: "SMTP_PASSWORD",
        },
      },
    },
    ai: {
      gatekeeper: { provider: "openai", model: "small-model", api_key_env: "OPENAI_API_KEY" },
      analyst: { provider: "anthropic", model: "strong-model", api_key_env: "ANTHROPIC_API_KEY" },
      target_language: "Vietnamese",
    },
  };
}

export function testConfig(mutate?: (raw: Record<string, unknown>) => void): AppConfig {
  const raw = rawConfig();
  mutate?.(raw);
  return parseConfig(raw, testEnv);
}
