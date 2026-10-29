/**
 * Measures SC-106 on a labelled set of .eml files: at least 90% of events with a clear date and
 * time produce the correct event (start, end, title), and no event is suggested for an email
 * without one. Runs the same invitation parser and Scheduler as the pipeline, against the AI
 * provider in your config (this makes real, billed calls).
 *
 *   npx tsx scripts/eval-scheduler.ts <dir> [--config config.json]
 *
 * <dir>/with-events/NAME.eml with NAME.expected.json: [{ "title": "...", "start": "<ISO>", "end": "<ISO>" }]
 * <dir>/no-events/NAME.eml
 * Start and end are instants (or YYYY-MM-DD for all-day events). Titles match case-insensitively
 * when the expected title appears in the detected one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { AiSdkLlmClient } from "../src/agents/llm.js";
import { detectEvents } from "../src/agents/scheduler.js";
import { loadConfig } from "../src/config/load.js";
import type { DetectedEvent } from "../src/domain/types.js";
import { parseAndClean } from "../src/fetcher/clean.js";
import { toIncomingEmail } from "../src/fetcher/incoming.js";

export interface ExpectedEvent {
  title: string;
  start: string;
  end: string;
}

export interface SchedulerSample {
  file: string;
  expected: ExpectedEvent[] | null;
  detected: Array<Pick<DetectedEvent, "title" | "start" | "end" | "timeSet">>;
}

export interface SchedulerScore {
  expectedEvents: number;
  correctEvents: number;
  accuracy: number;
  noEventEmails: number;
  falsePositives: number;
  passed: boolean;
}

const sameInstant = (a: string | null, b: string) =>
  a !== null && (a.length === 10 || b.length === 10 ? a === b : Date.parse(a) === Date.parse(b));

export function eventMatches(e: SchedulerSample["detected"][number], x: ExpectedEvent): boolean {
  return (
    e.timeSet &&
    sameInstant(e.start, x.start) &&
    sameInstant(e.end, x.end) &&
    e.title.toLowerCase().includes(x.title.toLowerCase())
  );
}

export function scoreScheduler(samples: SchedulerSample[]): SchedulerScore {
  let expectedEvents = 0;
  let correctEvents = 0;
  let noEventEmails = 0;
  let falsePositives = 0;
  for (const s of samples) {
    if (s.expected === null) {
      noEventEmails++;
      if (s.detected.length > 0) falsePositives++;
      continue;
    }
    expectedEvents += s.expected.length;
    correctEvents += s.expected.filter((x) => s.detected.some((e) => eventMatches(e, x))).length;
  }
  const accuracy = expectedEvents === 0 ? 1 : correctEvents / expectedEvents;
  return {
    expectedEvents,
    correctEvents,
    accuracy,
    noEventEmails,
    falsePositives,
    passed: accuracy >= 0.9 && falsePositives === 0,
  };
}

async function main(argv: string[]): Promise<number> {
  const dir = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--config");
  const i = argv.indexOf("--config");
  if (!dir) {
    console.error("Usage: npx tsx scripts/eval-scheduler.ts <dir> [--config config.json]");
    return 2;
  }
  dotenv.config({ quiet: true });
  const config = loadConfig((i >= 0 ? argv[i + 1] : undefined) ?? "config.json", process.env, {
    checkGrants: false,
  });
  if (!config.ai.scheduler) {
    console.error("Enable ai.scheduler in the config first.");
    return 2;
  }
  const llm = new AiSdkLlmClient(config.ai, {
    concurrency: config.limits.llm_concurrency,
    prices: config.ai.prices,
  });

  const samples: SchedulerSample[] = [];
  for (const folder of ["with-events", "no-events"] as const) {
    const path = join(dir, folder);
    if (!existsSync(path)) continue;
    for (const file of readdirSync(path).filter((f) => f.endsWith(".eml"))) {
      const cleaned = await parseAndClean(readFileSync(join(path, file)), {
        maxBodyChars: config.limits.max_body_chars,
        fallbackDate: new Date(),
      });
      const email = toIncomingEmail(
        { accountId: "eval", mailbox: "INBOX", uidValidity: "0", uid: "0" },
        cleaned,
        { email: "eval@localhost", webLink: null },
      );
      let detected: SchedulerSample["detected"] = [];
      try {
        // Links are irrelevant here; "now" before the email keeps every event linkable.
        const out = await detectEvents(llm, email, {
          enabled: true,
          timezone: config.timezone,
          outlookHost: config.calendar.outlookHost,
          now: new Date(0),
        });
        detected = out.events;
      } catch (err) {
        console.log(`! ${folder}/${file}: ${(err as Error).message}`);
      }
      const expectedFile = join(path, file.replace(/\.eml$/, ".expected.json"));
      const expected =
        folder === "no-events"
          ? null
          : (JSON.parse(readFileSync(expectedFile, "utf8")) as ExpectedEvent[]);
      samples.push({ file: `${folder}/${file}`, expected, detected });
      const ok =
        expected === null
          ? detected.length === 0
          : expected.every((x) => detected.some((e) => eventMatches(e, x)));
      console.log(`${ok ? "✓" : "✗"} ${folder}/${file} → ${detected.length} event(s)`);
    }
  }

  const s = scoreScheduler(samples);
  console.log(
    `\nEvents correct: ${s.correctEvents}/${s.expectedEvents} (${(s.accuracy * 100).toFixed(1)}%). ` +
      `False positives: ${s.falsePositives}/${s.noEventEmails} no-event emails.`,
  );
  if (s.expectedEvents < 30) console.log("Note: SC-106 asks for at least 30 emails with events.");
  console.log(s.passed ? "SC-106: PASS" : "SC-106: FAIL");
  return s.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    },
  );
}
