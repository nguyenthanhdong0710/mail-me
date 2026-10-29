import { DateTime } from "luxon";
import { calendarLinks, type OutlookHost } from "../calendar/links.js";
import { parseInvites, type InviteEvent } from "../calendar/invite.js";
import { isTimeZone } from "../config/schema.js";
import { formatSender } from "../courier/report.js";
import type { LlmClient } from "../domain/ports.js";
import {
  SchedulerSchema,
  type DetectedEvent,
  type IncomingEmail,
  type LlmUsage,
  type SchedulerResult,
} from "../domain/types.js";
import type { Logger } from "../lib/logger.js";
import { retry, type RetryOptions } from "../lib/retry.js";
import { emailBlock, loadPrompt } from "./prompt.js";

/** At most this many events are reported per email (FR-115). */
export const MAX_EVENTS = 3;
const DEFAULT_MINUTES = 60;

export interface SchedulerOptions {
  /** False stops the AI call; invitations are still read (they need no AI). */
  enabled: boolean;
  timezone: string;
  outlookHost: OutlookHost;
  now: Date;
  retry?: RetryOptions;
  log?: Logger;
}

export interface SchedulerOutcome {
  events: DetectedEvent[];
  eventsOmitted: number;
  usage: LlmUsage | null;
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Turns the model's local times into instants (contracts/scheduler.contract.md "Normalization").
 * The model never computes offsets; Luxon applies the stated or configured zone, including DST.
 */
export function normalizeEvents(result: SchedulerResult, userZone: string): InviteEvent[] {
  return result.events.map((e): InviteEvent => {
    const zone = e.timezone && isTimeZone(e.timezone) ? e.timezone : userZone;
    const base = {
      title: e.title.trim(),
      status: e.status,
      source: "ai" as const,
      timezone: zone,
      location: e.location?.trim() || null,
      meetingUrl: httpsUrl(e.meeting_url),
    };
    if (!e.time_known || !e.start_local) {
      return { ...base, timeSet: false, start: null, end: null, allDay: false };
    }
    const allDay = e.all_day || !e.start_local.includes("T");
    if (allDay) {
      const start = DateTime.fromISO(e.start_local.slice(0, 10));
      const last = e.end_local ? DateTime.fromISO(e.end_local.slice(0, 10)) : start;
      // The model gives the last day; calendar formats want an exclusive end.
      const end = last < start ? start.plus({ days: 1 }) : last.plus({ days: 1 });
      return { ...base, timeSet: true, allDay, start: start.toISODate(), end: end.toISODate() };
    }
    const start = DateTime.fromISO(e.start_local, { zone });
    let end = e.end_local?.includes("T") ? DateTime.fromISO(e.end_local, { zone }) : null;
    if (!end || end <= start) end = start.plus({ minutes: e.duration_minutes ?? DEFAULT_MINUTES });
    return {
      ...base,
      timeSet: true,
      allDay,
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
    };
  });
}

/**
 * Finds events in an IMPORTANT email (FR-113–117): from a calendar invitation without AI when
 * there is one, otherwise with the Scheduler model. Links are built by code. Throws on failure;
 * the caller still delivers the report (FR-119).
 */
export async function detectEvents(
  llm: LlmClient,
  email: Pick<
    IncomingEmail,
    "from" | "subject" | "text" | "attachments" | "sentAt" | "calendarParts"
  >,
  opts: SchedulerOptions,
): Promise<SchedulerOutcome> {
  let found: InviteEvent[];
  let usage: LlmUsage | null = null;
  if (email.calendarParts.length > 0) {
    found = parseInvites(email.calendarParts, opts.timezone);
  } else if (opts.enabled) {
    const user = [
      emailBlock(email),
      `<sent_at>${email.sentAt}</sent_at>`,
      `<user_timezone>${opts.timezone}</user_timezone>`,
    ].join("\n");
    const res = await retry(
      () =>
        llm.generate("scheduler", {
          system: loadPrompt("scheduler.v1"),
          user,
          schema: SchedulerSchema,
          log: opts.log,
        }),
      opts.retry,
    );
    usage = res.usage;
    found = normalizeEvents(res.value, opts.timezone);
  } else {
    return { events: [], eventsOmitted: 0, usage: null };
  }

  const from = formatSender(email.from);
  const events = found.slice(0, MAX_EVENTS).map((e) => ({
    ...e,
    links: calendarLinks(e, {
      from,
      subject: email.subject,
      outlookHost: opts.outlookHost,
      now: opts.now,
    }),
  }));
  return { events, eventsOmitted: Math.max(0, found.length - MAX_EVENTS), usage };
}
