import type { AppConfig } from "../../config/load.js";
import type { ReportChannel } from "../../domain/ports.js";
import type { ChannelName } from "../../domain/types.js";
import type { Logger } from "../../lib/logger.js";
import { EmailChannel } from "./email/smtp-channel.js";
import { TelegramChannel } from "./telegram/telegram-channel.js";

/** One channel per enabled `delivery.*` block (FR-020). */
export function buildChannels(
  config: AppConfig,
  installId: string,
): Map<ChannelName, ReportChannel> {
  const channels = new Map<ChannelName, ReportChannel>();
  if (config.delivery.email) {
    channels.set("email", new EmailChannel(config.delivery.email, installId));
  }
  if (config.delivery.telegram) {
    channels.set("telegram", new TelegramChannel(config.delivery.telegram));
  }
  return channels;
}

/**
 * Startup probe. Failures are logged, not fatal: the network may be down at startup and
 * deliveries are retried later.
 */
export async function verifyChannels(
  channels: Map<ChannelName, ReportChannel>,
  logger: Logger,
): Promise<void> {
  await Promise.all(
    [...channels.values()].map(async (channel) => {
      try {
        await channel.verify();
        logger.info({ channel: channel.name }, "delivery channel ready");
      } catch (err) {
        logger.error(
          { channel: channel.name, err: (err as Error).message },
          "delivery channel check failed",
        );
      }
    }),
  );
}
