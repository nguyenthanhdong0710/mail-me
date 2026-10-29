import type { Logger } from "../lib/logger.js";
import type { AppConfig } from "./load.js";

/** One-time hints about less safe settings (FR-106, research R6). */
export function logStartupNotices(config: AppConfig, logger: Logger): void {
  for (const a of config.accounts) {
    if (a.auth !== "password") continue;
    logger.info(
      { account: a.id, provider: a.provider },
      `account "${a.id}" uses a password, which is less safe than OAuth. Use OAuth where the provider supports it (see README)`,
    );
    if (a.provider === "custom" && a.imap?.host === "imap.gmail.com") {
      logger.info(
        { account: a.id },
        `account "${a.id}" is a Gmail account: set "provider": "gmail" and sign in with OAuth instead of an app password`,
      );
    }
  }
}
