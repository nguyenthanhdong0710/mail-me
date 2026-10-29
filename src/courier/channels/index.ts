import type { AppConfig, EmailChannelConfig } from "../../config/load.js";
import type { ReportChannel } from "../../domain/ports.js";
import type { ChannelName } from "../../domain/types.js";
import type { Logger } from "../../lib/logger.js";
import type { MailSender } from "../../domain/ports.js";
import { EmailChannel } from "./email/email-channel.js";
import { SmtpSender } from "./email/senders.js";
import { TelegramChannel } from "./telegram/telegram-channel.js";

/** One channel per enabled `delivery.*` block (FR-020). */
export function buildChannels(
  config: AppConfig,
  installId: string,
  /** Builds the send-only OAuth sender (Gmail API or Graph) for `delivery.email.oauth`. */
  oauthSender?: (oauth: NonNullable<EmailChannelConfig["oauth"]>) => MailSender,
): Map<ChannelName, ReportChannel> {
  const channels = new Map<ChannelName, ReportChannel>();
  const email = config.delivery.email;
  if (email) {
    let sender: MailSender;
    if (email.smtp) sender = new SmtpSender(email.smtp);
    else if (email.oauth && oauthSender) sender = oauthSender(email.oauth);
    else throw new Error("delivery.email has no usable sending account");
    channels.set("email", new EmailChannel(email, installId, sender));
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
