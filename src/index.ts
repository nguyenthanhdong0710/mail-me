#!/usr/bin/env node
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import { AiSdkLlmClient } from "./agents/llm.js";
import { PRICES_AS_OF } from "./agents/prices.js";
import { parseAuthArgs, runAuth, terminalIO } from "./auth/cli.js";
import { createOAuthWiring, type OAuthWiring } from "./auth/wiring.js";
import {
  ConfigError,
  grantRefs,
  loadConfig,
  TELEGRAM_TOKEN_PATTERN,
  telegramTokenProblem,
  type AppConfig,
} from "./config/load.js";
import { buildChannels, verifyChannels } from "./courier/channels/index.js";
import { findChats, TelegramBotApi } from "./courier/channels/telegram/telegram-channel.js";
import { ChannelError, systemClock } from "./domain/ports.js";
import type { Report } from "./domain/types.js";
import { mailSourceFactory } from "./fetcher/index.js";
import { logStartupNotices } from "./config/notices.js";
import { createLogger } from "./lib/logger.js";
import { Pipeline } from "./orchestrator/pipeline.js";
import { runOnce, startRetentionJob, startPolling } from "./orchestrator/poller.js";
import { SqliteStore } from "./store/sqlite-store.js";

const USAGE = `Usage: mail-me <command> [--config path]

Commands:
  start          Poll all accounts on the configured interval
  run-once       Poll all accounts once and exit (for cron / systemd timers)
  check-config   Validate the config and secrets, then exit
  check-delivery Send a test report to every enabled delivery channel
  auth <account-id> [--port 53682] [--listen 127.0.0.1]
                 Sign in an OAuth account (read-only mail access)
  auth --email-channel
                 Sign in the email channel's sending account (send-only)
  auth --status  List OAuth sign-ins and when they were last renewed
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
    key: { accountId: "check-delivery", mailbox: "INBOX", uidValidity: "0", uid: "0" },
    source: { accountId: "check-delivery", label: "Mail-Me setup check" },
    original: {
      messageId: null,
      from: { name: "Mail-Me", address: "mail-me@localhost" },
      subject: "Test report",
      receivedAt: now,
      to: { shown: config.accounts.slice(0, 5).map((a) => ({ address: a.email })), more: 0 },
      cc: { shown: [], more: 0 },
      deliveredTo: config.accounts[0]!.email,
      addressedToYou: true,
      webLink: null,
    },
    kind: "SUMMARY",
    style: config.ai.analystStyle,
    timezone: config.timezone,
    events: [],
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

async function checkDelivery(config: AppConfig, oauth: OAuthWiring): Promise<number> {
  const store = new SqliteStore(config.storage.path);
  const channels = buildChannels(config, store.getInstallId(), oauth.sender);
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
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) {
    console.error(telegramTokenProblem(envName));
    return 2;
  }
  let chats;
  try {
    chats = await findChats(new TelegramBotApi(token));
  } catch (err) {
    // Telegram answers 401/404 for a wrong token; retryable errors are network or server trouble.
    const hint =
      err instanceof ChannelError && !err.retryable
        ? `\nCheck that ${envName} is the token from @BotFather.`
        : "";
    console.error(`${(err as Error).message}${hint}`);
    return 1;
  }
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
  // `auth` exists to create missing grants, so it skips the grant checks (auth-cli.contract.md).
  const config = loadConfig(configPath(argv), process.env, { checkGrants: command !== "auth" });
  const secrets = new Set(config.secrets);
  const oauth = createOAuthWiring(config, { addSecret: (v) => secrets.add(v) });

  if (command === "auth") {
    const args = parseAuthArgs(argv.slice(1));
    const io = terminalIO();
    try {
      return await runAuth(args, {
        config,
        io,
        store: oauth.grants,
        client: (provider, a) =>
          oauth.client(provider, {
            port: a.port,
            listen: a.listen,
            loginHint: config.accounts.find((x) => x.id === a.accountId)?.email,
          }),
      });
    } finally {
      io.close();
    }
  }
  if (command === "check-config") {
    console.log(
      `Config OK: ${config.accounts.length} account(s), channels: ${[
        config.delivery.email && "email",
        config.delivery.telegram && "telegram",
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
    for (const { path, ref } of grantRefs(config)) {
      const grant = oauth.grants.read(ref.name);
      console.log(
        `  ${path}: signed in as ${grant?.address}, ${ref.purpose === "read" ? "read-only" : "send-only"}, renewed ${grant?.updatedAt}`,
      );
    }
    return 0;
  }
  if (command === "check-delivery") return checkDelivery(config, oauth);
  if (command !== "start" && command !== "run-once") {
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const logger = createLogger({ level: config.logLevel, secrets });
  logStartupNotices(config, logger);
  const store = new SqliteStore(config.storage.path);
  const channels = buildChannels(config, store.getInstallId(), oauth.sender);
  await verifyChannels(channels, logger);

  const pipeline = new Pipeline({
    config,
    store,
    llm: new AiSdkLlmClient(config.ai, {
      concurrency: config.limits.llm_concurrency,
      prices: config.ai.prices,
      logger,
    }),
    channels,
    sources: mailSourceFactory(config.accounts, oauth.source),
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
    {
      accounts: config.accounts.map((a) => a.id),
      intervalSeconds: config.pollIntervalSeconds,
      pricesAsOf: PRICES_AS_OF,
      note: "costs are estimates",
    },
    "mail-me started",
  );
  const stopRetention = startRetentionJob(store, config.storage.retention_days, logger);
  const stop = startPolling(pipeline, config.accounts, config.pollIntervalSeconds * 1000, logger);
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
