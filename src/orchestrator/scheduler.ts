import type { AccountConfig } from "../config/load.js";
import type { Logger } from "../lib/logger.js";
import type { Pipeline } from "./pipeline.js";

/** One pass over every account. A failing account never stops the others (FR-017). */
export async function runOnce(
  pipeline: Pipeline,
  accounts: AccountConfig[],
  logger: Logger,
): Promise<void> {
  for (const account of accounts) {
    try {
      await pipeline.pollAccount(account);
    } catch (err) {
      logger.error({ account: account.id, err: (err as Error).message }, "poll failed");
    }
  }
}

/**
 * Polls on a fixed interval. Uses setTimeout after each pass finishes, so passes never
 * overlap (research R11). Returns a stop function that resolves when the current pass ends.
 */
export function startScheduler(
  pipeline: Pipeline,
  accounts: AccountConfig[],
  intervalMs: number,
  logger: Logger,
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const tick = () => {
    current = runOnce(pipeline, accounts, logger).finally(() => {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  tick();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current;
  };
}
