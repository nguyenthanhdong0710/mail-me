import { readFileSync } from "node:fs";
import type { z } from "zod";
import { configSchema, type RawConfig } from "./schema.js";

export class ConfigError extends Error {
  override name = "ConfigError";
  readonly exitCode = 2;
}

export interface AccountConfig {
  id: string;
  label: string;
  email: string;
  imap: { host: string; port: number; secure: boolean; user: string; password: string };
  mailboxes: string[];
  lookbackHours: number;
}

export interface ModelConfig {
  provider: "openai" | "anthropic" | "google";
  model: string;
  apiKey: string;
}

export interface EmailChannelConfig {
  to: string;
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; password: string };
}

export interface TelegramChannelConfig {
  botToken: string;
  chatId: string;
}

/** Validated config with secrets resolved from the environment. */
export interface AppConfig {
  accounts: AccountConfig[];
  delivery: {
    email: EmailChannelConfig | null;
    telegram: TelegramChannelConfig | null;
    maxAttempts: number;
  };
  ai: { gatekeeper: ModelConfig; analyst: ModelConfig; targetLanguage: string };
  rules: RawConfig["rules"];
  pollIntervalSeconds: number;
  limits: RawConfig["limits"];
  storage: RawConfig["storage"];
  logLevel: RawConfig["logging"]["level"];
  /** Every resolved secret value, for log redaction. */
  secrets: string[];
}

function formatPath(path: PropertyKey[]): string {
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : `${i === 0 ? "" : "."}${String(p)}`))
    .join("");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `Invalid config: ${formatPath(i.path) || "(root)"} — ${i.message}`)
    .join("\n");
}

export function parseConfig(input: unknown, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error));
  const raw = parsed.data;

  const secrets: string[] = [];
  const problems: string[] = [];
  const secret = (path: string, name: string): string => {
    const value = env[name];
    if (!value) {
      problems.push(`Invalid config: ${path} — environment variable "${name}" is not set`);
      return "";
    }
    secrets.push(value);
    return value;
  };

  const accounts = raw.accounts.map((a, i) => ({
    id: a.id,
    label: a.label ?? a.id,
    email: a.email,
    imap: {
      host: a.imap.host,
      port: a.imap.port,
      secure: a.imap.secure,
      user: a.imap.user,
      password: secret(`accounts[${i}].imap.password_env`, a.imap.password_env),
    },
    mailboxes: a.mailboxes,
    lookbackHours: a.lookback_hours,
  }));

  const e = raw.delivery.email;
  const email: EmailChannelConfig | null =
    e.enabled && e.to && e.smtp
      ? {
          to: e.to,
          from: e.smtp.from ?? e.smtp.user,
          smtp: {
            host: e.smtp.host,
            port: e.smtp.port,
            secure: e.smtp.secure,
            user: e.smtp.user,
            password: secret("delivery.email.smtp.password_env", e.smtp.password_env),
          },
        }
      : null;

  const t = raw.delivery.telegram;
  let telegram: TelegramChannelConfig | null = null;
  if (t.enabled && t.bot_token_env && t.chat_id) {
    const botToken = secret("delivery.telegram.bot_token_env", t.bot_token_env);
    if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
      // Never echo the value: it is a secret even when malformed.
      problems.push(
        `Invalid config: delivery.telegram.bot_token_env — "${t.bot_token_env}" is not a Telegram bot token (expected <digits>:<token> from @BotFather)`,
      );
    }
    telegram = { botToken, chatId: t.chat_id };
  }

  const model = (role: "gatekeeper" | "analyst"): ModelConfig => ({
    provider: raw.ai[role].provider,
    model: raw.ai[role].model,
    apiKey: secret(`ai.${role}.api_key_env`, raw.ai[role].api_key_env),
  });
  const ai = {
    gatekeeper: model("gatekeeper"),
    analyst: model("analyst"),
    targetLanguage: raw.ai.target_language,
  };

  if (problems.length > 0) throw new ConfigError(problems.join("\n"));

  return {
    accounts,
    delivery: { email, telegram, maxAttempts: raw.delivery.max_attempts },
    ai,
    rules: raw.rules,
    pollIntervalSeconds: raw.schedule.poll_interval_seconds,
    limits: raw.limits,
    storage: raw.storage,
    logLevel: raw.logging.level,
    secrets,
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file "${path}": ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file "${path}" is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(json, env);
}
