import { z } from "zod";
import { sameMailbox } from "./address.js";
import { PROVIDER_NAMES, preset, type ProviderName } from "./providers.js";

// contracts/config.schema.md (001) and specs/002-oauth-providers-calendar/contracts/config.schema.md

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const port = z.number().int().min(1).max(65535);

/** Only for password accounts. Host, port and TLS may come from the provider preset. */
const imapSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: port.optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1).optional(),
    password_env: envName,
  })
  .strict();

const accountSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]+$/i, "use letters, digits, '-' or '_'"),
    label: z.string().min(1).optional(),
    email: z.email(),
    provider: z.enum(PROVIDER_NAMES).default("custom"),
    auth: z.enum(["oauth", "password"]).optional(),
    imap: imapSchema.optional(),
    mailboxes: z.array(z.string().min(1)).min(1).default(["INBOX"]),
    lookback_hours: z.number().min(0).default(0),
  })
  .strict()
  .superRefine((a, ctx) => {
    const p = preset(a.provider);
    const auth = a.auth ?? p.authMethods[0] ?? "password";
    if (!(p.authMethods as readonly string[]).includes(auth)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth"],
        message:
          a.provider === "microsoft"
            ? 'Microsoft turned off password sign-in for Outlook.com and Microsoft 365. Use "auth": "oauth"'
            : `provider "${a.provider}" supports ${p.authMethods.map((m) => `"${m}"`).join(" or ")}, not "${auth}"`,
      });
      return;
    }
    if (auth === "oauth" && a.imap) {
      ctx.addIssue({
        code: "custom",
        path: ["imap"],
        message: "only for password accounts; remove it for an OAuth account",
      });
    }
    if (auth === "password") {
      if (!a.imap) {
        ctx.addIssue({
          code: "custom",
          path: ["imap"],
          message: 'required for a password account (at least "password_env")',
        });
      } else if (!a.imap.host && !p.imap) {
        ctx.addIssue({
          code: "custom",
          path: ["imap", "host"],
          message: 'required unless "provider" names a preset (e.g. "yahoo")',
        });
      }
    }
  });

const smtpSchema = z
  .object({
    provider: z.enum(PROVIDER_NAMES).optional(),
    host: z.string().min(1).optional(),
    port: port.optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1),
    password_env: envName,
    from: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!s.host && !(s.provider && preset(s.provider).smtp)) {
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: 'required unless "provider" names a preset with an SMTP server',
      });
    }
  });

const emailOAuthSchema = z
  .object({
    provider: z.enum(["gmail", "microsoft"]),
    user: z.email(),
    from: z.string().min(1).optional(),
  })
  .strict();

const enabledEmailSchema = z
  .object({
    enabled: z.literal(true),
    to: z.email().optional(),
    oauth: emailOAuthSchema.optional(),
    smtp: smtpSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.to) ctx.addIssue({ code: "custom", path: ["to"], message: "required when enabled" });
    if (!v.oauth === !v.smtp) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          'set exactly one sending account: "oauth" (Gmail or Microsoft, no password) or "smtp" (password)',
      });
    }
  });

const enabledTelegramSchema = z
  .object({
    enabled: z.literal(true),
    bot_token_env: envName.optional(),
    chat_id: z
      .string()
      .regex(/^(-?\d+|@[A-Za-z0-9_]{5,})$/, "must be a numeric chat ID or @channelname")
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.bot_token_env)
      ctx.addIssue({ code: "custom", path: ["bot_token_env"], message: "required when enabled" });
    if (!v.chat_id)
      ctx.addIssue({ code: "custom", path: ["chat_id"], message: "required when enabled" });
  });

/**
 * A delivery channel whose settings are checked only when it is enabled: a disabled channel's
 * settings are neither required nor validated (FR-125).
 */
function optionalChannel<T extends z.ZodType<{ enabled: true }>>(enabledSchema: T) {
  return z
    .looseObject({ enabled: z.boolean().default(false) })
    .transform((v, ctx): z.infer<T> | { enabled: false } => {
      if (!v.enabled) return { enabled: false };
      const parsed = enabledSchema.safeParse(v);
      if (parsed.success) return parsed.data;
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return z.NEVER;
    });
}

const emailChannelSchema = optionalChannel(enabledEmailSchema);
const telegramChannelSchema = optionalChannel(enabledTelegramSchema);

const deliverySchema = z
  .object({
    email: emailChannelSchema.prefault({}),
    telegram: telegramChannelSchema.prefault({}),
    max_attempts: z.number().int().min(1).default(10),
  })
  .strict()
  .refine((d) => d.email.enabled || d.telegram.enabled, {
    message:
      "enable at least one channel: set delivery.email.enabled or delivery.telegram.enabled to true",
  });

const modelFields = {
  provider: z.enum(["openai", "anthropic", "google"]),
  model: z.string().min(1),
  api_key_env: envName,
  /** Anthropic only: workspace ID for API keys not scoped to a workspace. */
  workspace_id_env: envName.optional(),
};

const modelSchema = z.object(modelFields).strict();

const schedulerSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: modelFields.provider.optional(),
    model: modelFields.model.optional(),
    api_key_env: modelFields.api_key_env.optional(),
    workspace_id_env: modelFields.workspace_id_env,
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!s.enabled) return;
    for (const field of ["provider", "model", "api_key_env"] as const) {
      if (!s[field])
        ctx.addIssue({ code: "custom", path: [field], message: "required when enabled" });
    }
  });

const priceSchema = z
  .object({ input_per_mtok: z.number().min(0), output_per_mtok: z.number().min(0) })
  .strict();

const timeZone = z
  .string()
  .refine(isTimeZone, 'must be an IANA time zone, e.g. "Asia/Ho_Chi_Minh"');

export function isTimeZone(value: string): boolean {
  if (value === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const configSchema = z
  .object({
    timezone: timeZone.optional(),
    auth: z
      .object({
        grants_dir: z.string().min(1).default("data/grants"),
        google: z
          .object({ client_id: z.string().min(1), client_secret_env: envName })
          .strict()
          .optional(),
        microsoft: z
          .object({ client_id: z.string().min(1), tenant: z.string().min(1).default("common") })
          .strict()
          .optional(),
      })
      .strict()
      .prefault({}),
    accounts: z
      .array(accountSchema)
      .min(1)
      .refine((a) => new Set(a.map((x) => x.id)).size === a.length, {
        message: "account ids must be unique",
      }),
    delivery: deliverySchema,
    ai: z
      .object({
        gatekeeper: modelSchema,
        analyst: modelSchema.extend({ style: z.enum(["brief", "detailed"]).default("brief") }),
        scheduler: schedulerSchema.optional(),
        target_language: z.string().min(1),
        prices: z.record(z.string().min(1), priceSchema).default({}),
      })
      .strict(),
    calendar: z
      .object({
        outlook_host: z
          .enum(["outlook.live.com", "outlook.office.com"])
          .default("outlook.live.com"),
      })
      .strict()
      .prefault({}),
    rules: z
      .object({
        whitelist_domains: z.array(z.string().min(1)).default([]),
        drop_keywords: z.array(z.string().min(1)).default([]),
        confidence_threshold: z.number().min(0).max(1).default(0.7),
      })
      .strict()
      .prefault({}),
    schedule: z
      .object({ poll_interval_seconds: z.number().int().min(30).default(300) })
      .strict()
      .prefault({}),
    limits: z
      .object({
        max_body_chars: z.number().int().min(1000).default(12000),
        llm_concurrency: z.number().int().min(1).default(2),
        excerpt_chars: z.number().int().min(0).default(600),
        fetch_batch: z.number().int().min(1).default(50),
      })
      .strict()
      .prefault({}),
    storage: z
      .object({
        path: z.string().min(1).default("data/mail-me.db"),
        retention_days: z.number().int().min(1).default(90),
      })
      .strict()
      .prefault({}),
    logging: z
      .object({
        level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Each OAuth provider in use needs the user's own OAuth app (research R3).
    const needs = (oauth: "google" | "microsoft", who: string) => {
      if (cfg.auth[oauth]) return;
      ctx.addIssue({
        code: "custom",
        path: ["auth", oauth],
        message: `required because ${who} uses OAuth with ${oauth === "google" ? "gmail" : "microsoft"}`,
      });
    };
    cfg.accounts.forEach((a, i) => {
      const p = preset(a.provider);
      if ((a.auth ?? p.authMethods[0]) === "oauth" && p.oauthProvider) {
        needs(p.oauthProvider, `accounts[${i}] ("${a.id}")`);
      }
    });
    const e = cfg.delivery.email;
    if (e.enabled && "oauth" in e && e.oauth) {
      needs(e.oauth.provider === "gmail" ? "google" : "microsoft", "delivery.email.oauth");
    }

    // Reports sent to a monitored mailbox would be read back in (FR-021, research R15).
    const to = e.enabled && "to" in e ? e.to : undefined;
    if (!to) return;
    const i = cfg.accounts.findIndex(
      (a) => sameMailbox(to, a.email) || (a.imap?.user ? sameMailbox(to, a.imap.user) : false),
    );
    if (i < 0) return;
    ctx.addIssue({
      code: "custom",
      path: ["delivery", "email", "to"],
      message: `"${to}" is also monitored by accounts[${i}] ("${cfg.accounts[i]!.id}"). Reports would be read back in. Use an address that is not monitored.`,
    });
  });

export type RawConfig = z.infer<typeof configSchema>;
export type { ProviderName };
