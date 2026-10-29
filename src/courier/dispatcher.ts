import { ChannelError, type Clock, type ReportChannel, type Store } from "../domain/ports.js";
import type { ChannelName, DeliveryRow, Outcome, PendingReport } from "../domain/types.js";
import type { Logger } from "../lib/logger.js";
import { retry, type RetryOptions } from "../lib/retry.js";

export interface DispatchDeps {
  store: Store;
  channels: Map<ChannelName, ReportChannel>;
  clock: Clock;
  logger: Logger;
  maxAttempts: number;
  retry?: RetryOptions;
}

export type DispatchResult = { done: true; outcome: Outcome } | { done: false };

/**
 * Delivers one pending report to every channel that still needs it (contracts/delivery.contract.md).
 * Channels already DELIVERED are never retried, so no channel gets a duplicate (FR-024).
 */
export async function dispatch(
  pending: PendingReport,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const { report, draft } = pending;
  const now = deps.clock.now();

  const rows = await Promise.all(
    pending.deliveries.map(async (row): Promise<DeliveryRow> => {
      if (row.status !== "PENDING") return row;
      if (row.nextAttemptAt && new Date(row.nextAttemptAt) > now) return row;

      const channel = deps.channels.get(row.channel);
      if (!channel) {
        const updated = {
          ...row,
          status: "GAVE_UP" as const,
          lastError: "channel is no longer enabled",
        };
        deps.store.updateDelivery(updated);
        return updated;
      }

      let partsSent = row.partsSent;
      try {
        const { externalId } = await retry(
          async () => {
            try {
              return await channel.deliver(report, { partsSent });
            } catch (err) {
              if (err instanceof ChannelError && err.partsSent !== undefined) {
                partsSent = err.partsSent;
              }
              throw err;
            }
          },
          {
            ...deps.retry,
            // A server-requested wait (Telegram 429) is honoured on a later poll instead.
            shouldRetry: (err) =>
              !(err instanceof ChannelError) || (err.retryable && err.retryAfterMs === undefined),
          },
        );
        const updated = {
          ...row,
          status: "DELIVERED" as const,
          partsSent,
          attempts: row.attempts + 1,
          externalId,
          lastError: null,
          nextAttemptAt: null,
        };
        deps.store.updateDelivery(updated);
        deps.logger.info({ key: report.key, channel: row.channel, externalId }, "report delivered");
        return updated;
      } catch (err) {
        const ce = err instanceof ChannelError ? err : new ChannelError(String(err), true);
        const attempts = row.attempts + 1;
        const giveUp = !ce.retryable || attempts >= deps.maxAttempts;
        const updated: DeliveryRow = {
          ...row,
          status: giveUp ? "GAVE_UP" : "PENDING",
          attempts,
          partsSent,
          lastError: ce.message,
          nextAttemptAt: ce.retryAfterMs
            ? new Date(now.getTime() + ce.retryAfterMs).toISOString()
            : null,
        };
        deps.store.updateDelivery(updated);
        const log = { key: report.key, channel: row.channel, attempts, err: ce.message };
        if (giveUp) deps.logger.error(log, "report delivery gave up");
        else deps.logger.warn(log, "report delivery failed, will retry next poll");
        return updated;
      }
    }),
  );

  if (rows.some((r) => r.status === "PENDING")) return { done: false };

  const outcome: Outcome = rows.every((r) => r.status === "GAVE_UP")
    ? "DELIVERY_FAILED"
    : report.kind === "SUMMARY"
      ? "FORWARDED"
      : "FALLBACK_FORWARDED";
  deps.store.completeReport({ ...draft, outcome, processedAt: deps.clock.now().toISOString() });
  return { done: true, outcome };
}
