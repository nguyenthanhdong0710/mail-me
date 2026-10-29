import { readFileSync } from "node:fs";
import type { z } from "zod";
import { FileGrantStore, readGrantName, SEND_GRANT_NAME } from "../auth/grants.js";
import { scopeProblem } from "../auth/scopes.js";
import type { GrantPurpose, GrantStore, OAuthProvider } from "../domain/ports.js";
import type { ModelPrice } from "../agents/prices.js";
import { sameMailbox } from "./address.js";
import { preset, type AuthMethod, type ProviderName, type ProviderPreset } from "./providers.js";
import { configSchema, type RawConfig } from "./schema.js";

export class ConfigError extends Error {
  override name = "ConfigError";
  readonly exitCode = 2;
}

/** `<bot id>:<secret>` as issued by @BotFather. */
export const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

export function telegramTokenProblem(envName: string): string {
  // Never echo the value: it is a secret even when malformed.
  return `"${envName}" is not a Telegram bot token (expected <digits>:<token> from @BotFather, without quotes)`;
}

/** Which grant file an OAuth account or the email channel uses. */
export interface GrantRef {
  name: string;
  provider: OAuthProvider;
  purpose: GrantPurpose;
  /** Address the grant must belong to. */
  address: string;
  /** Command that creates the grant. */
  fixCommand: string;
}

export interface AccountConfig {
  id: string;
  label: string;
  email: string;
  provider: ProviderName;
  auth: AuthMethod;
  /** Set for password accounts only. */
  imap: { host: string; port: number; secure: boolean; user: string; password: string } | null;
  /** Set for OAuth accounts only. */
  grant: GrantRef | null;
  /** How "Open original" links are built for this account (research R7). */
  webLink: ProviderPreset["webLink"];
  mailboxes: string[];
  lookbackHours: number;
}

export interface ModelConfig {
  provider: "openai" | "anthropic" | "google";
  model: string;
  apiKey: string;
  /** Sent as the anthropic-workspace-id header when set. */
  workspaceId?: string;
}

export interface EmailChannelConfig {
  to: string;
  from: string;
  /** Exactly one of `smtp` (password) and `oauth` (send-only grant) is set. */
  smtp: { host: string; port: number; secure: boolean; user: string; password: string } | null;
  oauth: { provider: "gmail" | "microsoft"; user: string; grant: GrantRef } | null;
}

export interface TelegramChannelConfig {
  botToken: string;
  chatId: string;
}

export interface OAuthAppConfig {
  grantsDir: string;
  google: { clientId: string; clientSecret: string } | null;
  microsoft: { clientId: string; tenant: string } | null;
}

/** Validated config with secrets resolved from the environment. */
export interface AppConfig {
  accounts: AccountConfig[];
  auth: OAuthAppConfig;
  delivery: {
    email: EmailChannelConfig | null;
    telegram: TelegramChannelConfig | null;
    maxAttempts: number;
  };
  ai: {
    gatekeeper: ModelConfig;
    analyst: ModelConfig;
    /** Null when the Scheduler is disabled. */
    scheduler: ModelConfig | null;
    targetLanguage: string;
    analystStyle: "brief" | "detailed";
    prices: Record<string, ModelPrice>;
  };
  /** IANA zone for event times (research R12). */
  timezone: string;
  calendar: { outlookHost: "outlook.live.com" | "outlook.office.com" };
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

  const accounts = raw.accounts.map((a, i): AccountConfig => {
    const p = preset(a.provider);
    const auth = a.auth ?? p.authMethods[0]!;
    // Explicit settings win over the preset (FR-107).
    const imap =
      auth === "password" && a.imap
        ? {
            host: a.imap.host ?? p.imap?.host ?? "",
            port: a.imap.port ?? p.imap?.port ?? 993,
            secure: a.imap.secure ?? p.imap?.secure ?? true,
            user: a.imap.user ?? a.email,
            password: secret(`accounts[${i}].imap.password_env`, a.imap.password_env),
          }
        : null;
    const grant: GrantRef | null =
      auth === "oauth" && p.oauthProvider
        ? {
            name: readGrantName(a.id),
            provider: p.oauthProvider,
            purpose: "read",
            address: a.email,
            fixCommand: `mail-me auth ${a.id}`,
          }
        : null;
    return {
      id: a.id,
      label: a.label ?? a.id,
      email: a.email,
      provider: a.provider,
      auth,
      imap,
      grant,
      webLink: p.webLink,
      mailboxes: a.mailboxes,
      lookbackHours: a.lookback_hours,
    };
  });

  const auth: OAuthAppConfig = {
    grantsDir: raw.auth.grants_dir,
    google: raw.auth.google
      ? {
          clientId: raw.auth.google.client_id,
          clientSecret: secret("auth.google.client_secret_env", raw.auth.google.client_secret_env),
        }
      : null,
    microsoft: raw.auth.microsoft
      ? { clientId: raw.auth.microsoft.client_id, tenant: raw.auth.microsoft.tenant }
      : null,
  };

  const e = raw.delivery.email;
  let email: EmailChannelConfig | null = null;
  if (e.enabled && e.to && e.smtp) {
    const sp = e.smtp.provider ? preset(e.smtp.provider).smtp : null;
    email = {
      to: e.to,
      from: e.smtp.from ?? e.smtp.user,
      smtp: {
        host: e.smtp.host ?? sp?.host ?? "",
        port: e.smtp.port ?? sp?.port ?? 465,
        secure: e.smtp.secure ?? sp?.secure ?? true,
        user: e.smtp.user,
        password: secret("delivery.email.smtp.password_env", e.smtp.password_env),
      },
      oauth: null,
    };
  } else if (e.enabled && e.to && e.oauth) {
    email = {
      to: e.to,
      from: e.oauth.from ?? e.oauth.user,
      smtp: null,
      oauth: {
        provider: e.oauth.provider,
        user: e.oauth.user,
        grant: {
          name: SEND_GRANT_NAME,
          provider: e.oauth.provider === "gmail" ? "google" : "microsoft",
          purpose: "send",
          address: e.oauth.user,
          fixCommand: "mail-me auth --email-channel",
        },
      },
    };
  }

  const t = raw.delivery.telegram;
  let telegram: TelegramChannelConfig | null = null;
  if (t.enabled && t.bot_token_env && t.chat_id) {
    const botToken = secret("delivery.telegram.bot_token_env", t.bot_token_env);
    if (botToken && !TELEGRAM_TOKEN_PATTERN.test(botToken)) {
      problems.push(
        `Invalid config: delivery.telegram.bot_token_env — ${telegramTokenProblem(t.bot_token_env)}`,
      );
    }
    telegram = { botToken, chatId: t.chat_id };
  }

  const model = (
    role: string,
    m: {
      provider: ModelConfig["provider"];
      model: string;
      api_key_env: string;
      workspace_id_env?: string;
    },
  ): ModelConfig => ({
    provider: m.provider,
    model: m.model,
    apiKey: secret(`ai.${role}.api_key_env`, m.api_key_env),
    ...(m.workspace_id_env && {
      workspaceId: secret(`ai.${role}.workspace_id_env`, m.workspace_id_env),
    }),
  });
  const s = raw.ai.scheduler;
  const ai: AppConfig["ai"] = {
    gatekeeper: model("gatekeeper", raw.ai.gatekeeper),
    analyst: model("analyst", raw.ai.analyst),
    scheduler:
      s?.enabled && s.provider && s.model && s.api_key_env
        ? model("scheduler", {
            provider: s.provider,
            model: s.model,
            api_key_env: s.api_key_env,
            ...(s.workspace_id_env && { workspace_id_env: s.workspace_id_env }),
          })
        : null,
    targetLanguage: raw.ai.target_language,
    analystStyle: raw.ai.analyst.style,
    prices: raw.ai.prices,
  };

  if (problems.length > 0) throw new ConfigError(problems.join("\n"));

  return {
    accounts,
    auth,
    delivery: { email, telegram, maxAttempts: raw.delivery.max_attempts },
    ai,
    timezone: raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    calendar: { outlookHost: raw.calendar.outlook_host },
    rules: raw.rules,
    pollIntervalSeconds: raw.schedule.poll_interval_seconds,
    limits: raw.limits,
    storage: raw.storage,
    logLevel: raw.logging.level,
    secrets,
  };
}

/** Every grant the config relies on, with the config path that names it. */
export function grantRefs(config: AppConfig): Array<{ path: string; ref: GrantRef }> {
  const refs = config.accounts.flatMap((a, i) =>
    a.grant ? [{ path: `accounts[${i}] ("${a.id}")`, ref: a.grant }] : [],
  );
  const sender = config.delivery.email?.oauth;
  if (sender) refs.push({ path: "delivery.email.oauth", ref: sender.grant });
  return refs;
}

function clientIdFor(config: AppConfig, provider: OAuthProvider): string | undefined {
  return provider === "google" ? config.auth.google?.clientId : config.auth.microsoft?.clientId;
}

/**
 * Startup checks for OAuth grants (FR-108): each grant exists, is readable only by us, belongs
 * to the configured address and OAuth app, and holds the right scopes and nothing more.
 */
export function checkGrants(
  config: AppConfig,
  store: GrantStore = new FileGrantStore(config.auth.grantsDir),
): void {
  const problems: string[] = [];
  for (const { path, ref } of grantRefs(config)) {
    let grant;
    try {
      grant = store.read(ref.name);
    } catch (err) {
      problems.push(`${path}: ${(err as Error).message}`);
      continue;
    }
    if (!grant) {
      problems.push(`${path}: not signed in. Run: ${ref.fixCommand}`);
      continue;
    }
    if (grant.provider !== ref.provider || grant.purpose !== ref.purpose) {
      problems.push(
        `${path}: the grant file is for ${grant.provider}/${grant.purpose}, not ${ref.provider}/${ref.purpose}. Run: ${ref.fixCommand}`,
      );
      continue;
    }
    if (!sameMailbox(grant.address, ref.address)) {
      problems.push(
        `${path}: signed in as ${grant.address}, but the config says ${ref.address}. Run: ${ref.fixCommand}`,
      );
      continue;
    }
    if (grant.clientId !== clientIdFor(config, ref.provider)) {
      problems.push(
        `${path}: the grant was issued to a different OAuth app (client ID changed). Run: ${ref.fixCommand}`,
      );
      continue;
    }
    const scopes = scopeProblem(ref.provider, ref.purpose, grant.scopes);
    if (scopes) problems.push(`${path}: ${scopes}. Run: ${ref.fixCommand}`);
  }
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
}

export function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { checkGrants?: boolean } = {},
): AppConfig {
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
  const config = parseConfig(json, env);
  if (opts.checkGrants ?? true) checkGrants(config);
  return config;
}
