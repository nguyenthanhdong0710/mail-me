#!/usr/bin/env node
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import { AiSdkLlmClient } from "./agents/llm.js";
import { ConfigError, loadConfig, type AppConfig } from "./config/load.js";
import { buildChannels, verifyChannels } from "./courier/channels/index.js";
import { findChats, TelegramBotApi } from "./courier/channels/telegram/telegram-channel.js";
import { systemClock } from "./domain/ports.js";
import type { Report } from "./domain/types.js";
import { imapSourceFactory } from "./fetcher/imap-source.js";
import { createLogger } from "./lib/logger.js";
import { Pipeline } from "./orchestrator/pipeline.js";
import { runOnce, startRetentionJob, startScheduler } from "./orchestrator/scheduler.js";
import { SqliteStore } from "./store/sqlite-store.js";

const USAGE = `Usage: mail-me <command> [--config path]

Commands:
  start          Poll all accounts on the configured interval
  run-once       Poll all accounts once and exit (for cron / systemd timers)
  check-config   Validate the config and secrets, then exit
  check-delivery Send a test report to every enabled delivery channel
  telegram-chat-id
                 List the chats that have messaged your Telegram bot (send it /start first)`;

function configPath(argv: string[]): string {
  const i = argv.indexOf("--config");
  return (i >= 0 ? argv[i + 1] : undefined) ?? process.env.MAIL_ME_CONFIG ?? "config.json";
}

/** A harmless report used by `check-delivery` (FR-025). */
function testReport(config: AppConfig): Report {
  const now = new Date().toISOString();
  return {
    key: { accountId: "check-delivery", mailbox: "INBOX", uidValidity: 0, uid: 0 },
    source: { accountId: "check-delivery", label: "Mail-Me setup check" },
    original: {
      messageId: null,
      from: { name: "Mail-Me", address: "mail-me@localhost" },
      subject: "Test report",
      receivedAt: now,
    },
    kind: "SUMMARY",
    analysis: {
      original_language: "English",
      summary: `Delivery works. Real reports will be summarized in ${config.ai.targetLanguage}.`,
      key_points: [`Monitored accounts: ${config.accounts.map((a) => a.label).join(", ")}`],
      action_items: [],
      requires_immediate_attention: false,
    },
    excerpt: "This is a test report sent by `mail-me check-delivery`.",
    truncated: false,
    urgent: false,
    actionNeeded: false,
  };
}

async function checkDelivery(config: AppConfig): Promise<number> {
  const store = new SqliteStore(config.storage.path);
  const channels = buildChannels(config, store.getInstallId());
  store.close();
  let failures = 0;
  for (const channel of channels.values()) {
    try {
      await channel.verify();
      const { externalId } = await channel.deliver(testReport(config));
      console.log(`✓ ${channel.name}: test report sent (${externalId})`);
    } catch (err) {
      console.error(`✗ ${channel.name}: ${(err as Error).message}`);
      failures++;
    }
  }
  return failures === 0 ? 0 : 1;
}

/**
 * Setup helper: runs before the config is valid (chat_id is not known yet), so it only
 * reads which env var holds the token, defaulting to TELEGRAM_BOT_TOKEN.
 */
async function telegramChatId(path: string): Promise<number> {
  let envName = "TELEGRAM_BOT_TOKEN";
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      delivery?: { telegram?: { bot_token_env?: unknown } };
    };
    const name = raw.delivery?.telegram?.bot_token_env;
    if (typeof name === "string" && name) envName = name;
  } catch {
    // No or unreadable config yet: use the default name.
  }
  const token = process.env[envName];
  if (!token) {
    console.error(`Set ${envName} to your bot token from @BotFather first.`);
    return 2;
  }
  const api = new TelegramBotApi(token);
  const chats = await findChats(api);
  if (chats.length === 0) {
    console.log("No chats found. Open your bot in Telegram, send it /start, then run this again.");
    return 1;
  }
  console.log("Chats that messaged your bot (put one in delivery.telegram.chat_id as a string):");
  for (const c of chats) console.log(`  ${c.id}\t${c.type}\t${c.name}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  dotenv.config({ quiet: true });

  if (command === "telegram-chat-id") return telegramChatId(configPath(argv));
  const config = loadConfig(configPath(argv));
  if (command === "check-config") {
    console.log(
      `Config OK: ${config.accounts.length} account(s), channels: ${[
        config.delivery.email && "email",
        config.delivery.telegram && "telegram",
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
    return 0;
  }
  if (command === "check-delivery") return checkDelivery(config);
  if (command !== "start" && command !== "run-once") {
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const logger = createLogger({ level: config.logLevel, secrets: config.secrets });
  const store = new SqliteStore(config.storage.path);
  const channels = buildChannels(config, store.getInstallId());
  await verifyChannels(channels, logger);

  const pipeline = new Pipeline({
    config,
    store,
    llm: new AiSdkLlmClient(config.ai, config.limits.llm_concurrency),
    channels,
    sources: imapSourceFactory(config.accounts),
    clock: systemClock,
    logger,
  });

  if (command === "run-once") {
    store.purgeOlderThan(config.storage.retention_days, new Date());
    await runOnce(pipeline, config.accounts, logger);
    store.close();
    return 0;
  }

  logger.info(
    { accounts: config.accounts.map((a) => a.id), intervalSeconds: config.pollIntervalSeconds },
    "mail-me started",
  );
  const stopRetention = startRetentionJob(store, config.storage.retention_days, logger);
  const stop = startScheduler(pipeline, config.accounts, config.pollIntervalSeconds * 1000, logger);
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  logger.info("shutting down");
  await Promise.all([stop(), stopRetention()]);
  store.close();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    console.error(err);
    process.exit(1);
  },
);
