import type { AccountConfig } from "../config/load.js";
import type { Store } from "../domain/ports.js";
import type { Logger } from "../lib/logger.js";
import type { Pipeline } from "./pipeline.js";

/** Longest wait between polls of an account that keeps failing. */
export const MAX_BACKOFF_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

/** Delay before the next poll: the interval, doubled per consecutive failure, capped. */
export function nextDelay(intervalMs: number, failures: number): number {
  if (failures === 0) return intervalMs;
  return Math.min(Math.max(intervalMs, intervalMs * 2 ** Math.min(failures, 16)), MAX_BACKOFF_MS);
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Starts a repeating task with setTimeout after each run finishes, so runs never overlap
 * (research R11). `run` returns the delay before the next run. Returns a stop function that
 * resolves once the current run ends.
 */
function loop(run: () => Promise<number>, timers: Timers): () => Promise<void> {
  let stopped = false;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();

  const tick = () => {
    current = run().then((delay) => {
      if (!stopped) handle = timers.setTimeout(tick, delay);
    });
  };
  tick();

  return async () => {
    stopped = true;
    if (handle !== undefined) timers.clearTimeout(handle);
    await current;
  };
}

/**
 * One independent polling loop per account. A failing account backs off exponentially
 * without delaying the others (FR-017).
 */
export function startPolling(
  pipeline: Pipeline,
  accounts: AccountConfig[],
  intervalMs: number,
  logger: Logger,
  timers: Timers = realTimers,
): () => Promise<void> {
  const stops = accounts.map((account) => {
    let failures = 0;
    return loop(async () => {
      try {
        await pipeline.pollAccount(account);
        if (failures > 0) logger.info({ account: account.id }, "account recovered");
        failures = 0;
      } catch (err) {
        failures++;
        const delay = nextDelay(intervalMs, failures);
        logger.error(
          { account: account.id, err: (err as Error).message, failures, retryInMs: delay },
          "poll failed, backing off",
        );
      }
      return nextDelay(intervalMs, failures);
    }, timers);
  });
  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}

/** Deletes processing records older than the retention window, now and once a day. */
export function startRetentionJob(
  store: Store,
  retentionDays: number,
  logger: Logger,
  now: () => Date = () => new Date(),
  timers: Timers = realTimers,
): () => Promise<void> {
  return loop(async () => {
    try {
      const purged = store.purgeOlderThan(retentionDays, now());
      if (purged > 0) logger.info({ purged, retentionDays }, "old processing records removed");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "retention purge failed");
    }
    return DAY_MS;
  }, timers);
}
