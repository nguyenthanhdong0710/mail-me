#!/usr/bin/env node
import dotenv from "dotenv";
import { AiSdkLlmClient } from "./agents/llm.js";
import { ConfigError, loadConfig, type AppConfig } from "./config/load.js";
import { EmailChannel } from "./courier/channels/email/smtp-channel.js";
import { systemClock, type ReportChannel, type Store } from "./domain/ports.js";
import type { ChannelName } from "./domain/types.js";
import { imapSourceFactory } from "./fetcher/imap-source.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { Pipeline } from "./orchestrator/pipeline.js";
import { runOnce, startScheduler } from "./orchestrator/scheduler.js";
import { SqliteStore } from "./store/sqlite-store.js";

const USAGE = `Usage: mail-me <command> [--config path]

Commands:
  start          Poll all accounts on the configured interval
  run-once       Poll all accounts once and exit (for cron / systemd timers)
  check-config   Validate the config and secrets, then exit`;

function configPath(argv: string[]): string {
  const i = argv.indexOf("--config");
  return (i >= 0 ? argv[i + 1] : undefined) ?? process.env.MAIL_ME_CONFIG ?? "config.json";
}

function buildChannels(config: AppConfig, store: Store): Map<ChannelName, ReportChannel> {
  const channels = new Map<ChannelName, ReportChannel>();
  if (config.delivery.email) {
    channels.set("email", new EmailChannel(config.delivery.email, store.getInstallId()));
  }
  if (config.delivery.telegram) {
    throw new ConfigError(
      "Invalid config: delivery.telegram — the Telegram channel is not implemented yet; set enabled: false",
    );
  }
  return channels;
}

async function verifyChannels(
  channels: Map<ChannelName, ReportChannel>,
  logger: Logger,
): Promise<void> {
  for (const channel of channels.values()) {
    try {
      await channel.verify();
      logger.info({ channel: channel.name }, "delivery channel ready");
    } catch (err) {
      // Not fatal: the network may be down at startup; deliveries are retried later.
      logger.error(
        { channel: channel.name, err: (err as Error).message },
        "delivery channel check failed",
      );
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  dotenv.config({ quiet: true });

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
  if (command !== "start" && command !== "run-once") {
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const logger = createLogger({ level: config.logLevel, secrets: config.secrets });
  const store = new SqliteStore(config.storage.path);
  const purged = store.purgeOlderThan(config.storage.retention_days, new Date());
  if (purged > 0) logger.info({ purged }, "old processing records removed");

  const channels = buildChannels(config, store);
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
    await runOnce(pipeline, config.accounts, logger);
    store.close();
    return 0;
  }

  logger.info(
    { accounts: config.accounts.map((a) => a.id), intervalSeconds: config.pollIntervalSeconds },
    "mail-me started",
  );
  const stop = startScheduler(pipeline, config.accounts, config.pollIntervalSeconds * 1000, logger);
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  logger.info("shutting down");
  await stop();
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
