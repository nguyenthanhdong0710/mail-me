import { z } from "zod";

// contracts/config.schema.md

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const imapSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true),
    user: z.string().min(1),
    password_env: envName,
  })
  .strict();

const accountSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]+$/i, "use letters, digits, '-' or '_'"),
    label: z.string().min(1).optional(),
    email: z.email(),
    imap: imapSchema,
    mailboxes: z.array(z.string().min(1)).min(1).default(["INBOX"]),
    lookback_hours: z.number().min(0).default(0),
  })
  .strict();

const smtpSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(465),
    secure: z.boolean().default(true),
    user: z.string().min(1),
    password_env: envName,
    from: z.string().min(1).optional(),
  })
  .strict();

const emailChannelSchema = z
  .object({
    enabled: z.boolean().default(false),
    to: z.email().optional(),
    smtp: smtpSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.enabled) return;
    if (!v.to) ctx.addIssue({ code: "custom", path: ["to"], message: "required when enabled" });
    if (!v.smtp) ctx.addIssue({ code: "custom", path: ["smtp"], message: "required when enabled" });
  });

const telegramChannelSchema = z
  .object({
    enabled: z.boolean().default(false),
    bot_token_env: envName.optional(),
    chat_id: z
      .string()
      .regex(/^(-?\d+|@[A-Za-z0-9_]{5,})$/, "must be a numeric chat ID or @channelname")
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.enabled) return;
    if (!v.bot_token_env)
      ctx.addIssue({ code: "custom", path: ["bot_token_env"], message: "required when enabled" });
    if (!v.chat_id)
      ctx.addIssue({ code: "custom", path: ["chat_id"], message: "required when enabled" });
  });

const deliverySchema = z
  .object({
    email: emailChannelSchema.prefault({}),
    telegram: telegramChannelSchema.prefault({}),
    max_attempts: z.number().int().min(1).default(10),
  })
  .strict()
  .refine((d) => d.email.enabled || d.telegram.enabled, {
    message: "enable at least one channel (email or telegram)",
  });

const modelSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "google"]),
    model: z.string().min(1),
    api_key_env: envName,
  })
  .strict();

export const configSchema = z
  .object({
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
        analyst: modelSchema,
        target_language: z.string().min(1),
      })
      .strict(),
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
  .strict();

export type RawConfig = z.infer<typeof configSchema>;
