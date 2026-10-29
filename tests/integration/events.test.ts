import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildMime } from "../../src/courier/channels/email/email-channel.js";
import { renderEmail } from "../../src/courier/channels/email/render.js";
import { renderTelegram } from "../../src/courier/channels/telegram/render.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/poller.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer, promotion } from "../fakes/index.js";
import { calendarFixture } from "../fixtures/calendar/load.js";

const teams = {
  title: "Project sync",
  status: "new",
  time_known: true,
  all_day: false,
  start_local: "2026-11-06T14:00",
  end_local: null,
  duration_minutes: 45,
  timezone: null,
  location: null,
  meeting_url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz",
};

async function run(
  fixtures: string[],
  opts: { scheduler?: () => unknown; enabled?: boolean; gatekeeper?: () => unknown } = {},
) {
  const config = testConfig((raw) => {
    raw.timezone = "Asia/Ho_Chi_Minh";
    if (opts.enabled !== false) {
      (raw.ai as Record<string, unknown>).scheduler = {
        provider: "openai",
        model: "tiny",
        api_key_env: "OPENAI_API_KEY",
      };
    }
  });
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger(
    { level: "info" },
    new Writable({
      write(chunk, _e, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    }),
  );
  const llm = new FakeLlm({
    ...(opts.scheduler && { scheduler: opts.scheduler }),
    ...(opts.gatekeeper && { gatekeeper: opts.gatekeeper }),
  });
  const server = new FakeMailServer();
  const channel = new FakeChannel("email");
  const pipeline = new Pipeline({
    config,
    store: new SqliteStore(":memory:"),
    llm,
    channels: new Map([["email", channel]]),
    sources: server.factory(),
    clock: new FakeClock(new Date("2026-11-02T03:00:00Z")),
    logger,
    retry: { attempts: 1, sleep: async () => {} },
  });
  await runOnce(pipeline, config.accounts, logger);
  for (const f of fixtures) server.deliver("school", calendarFixture(f));
  await runOnce(pipeline, config.accounts, logger);
  return { delivered: channel.delivered, llm, lines };
}

describe("meeting suggestions end to end (US4)", () => {
  it("reads an invitation without calling the Scheduler (FR-114)", async () => {
    const { delivered, llm } = await run(["outlook-invite-windows-tz"], {
      scheduler: () => ({ events: [teams] }),
    });
    expect(llm.callsFor("scheduler")).toBe(0);
    expect(delivered[0]!.events).toHaveLength(1);
    expect(delivered[0]!.events![0]).toMatchObject({
      source: "invitation",
      start: "2026-11-06T07:00:00.000Z",
    });
  });

  it("shows the event with both links and attaches event.ics to email only (US4-1)", async () => {
    const { delivered } = await run(["meeting-teams"], { scheduler: () => ({ events: [teams] }) });
    const r = delivered[0]!;
    expect(r.events![0]!.links).not.toBeNull();
    const html = renderEmail(r).html;
    expect(html).toContain("📅 <b>Project sync — Fri 6 Nov, 14:00–14:45 (Asia/Ho_Chi_Minh)</b>");
    expect(html).toContain(">Add to Google Calendar</a>");
    expect(html).toContain(">Add to Outlook calendar</a>");
    const tg = renderTelegram(r).join("\n");
    expect(tg).toContain("Add to Google Calendar</a>");

    const { mime } = await buildMime(
      r,
      { from: "a@b.c", to: "d@e.f" },
      "i",
      new Date("2026-11-02T00:00:00Z"),
    );
    const text = mime.toString();
    expect(text).toContain("filename=event.ics");
    expect(text).toMatch(/Content-Type: text\/calendar; method=PUBLISH; charset=utf-8/);
  });

  it("delivers the report with a notice when the Scheduler fails (FR-119, constitution III)", async () => {
    const { delivered, lines } = await run(["meeting-teams"], {
      scheduler: () => ({ events: [{ ...teams, status: "maybe" }] }),
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.events).toEqual([]);
    expect(delivered[0]!.schedulerFailed).toBe(true);
    expect(delivered[0]!.kind).toBe("SUMMARY");
    expect(renderEmail(delivered[0]!).text).toContain("Event detection failed");
    expect(renderTelegram(delivered[0]!).join("\n")).toContain("Event detection failed");
    expect(lines.some((l) => l.msg === "scheduler failed")).toBe(true);
  });

  it("makes no Scheduler AI call when disabled, but still reads invitations (FR-113)", async () => {
    const { llm, delivered } = await run(["meeting-teams", "google-invite"], { enabled: false });
    expect(llm.callsFor("scheduler")).toBe(0);
    expect(
      delivered.find((r) => r.original.subject === "Project sync on Thursday")!.events,
    ).toEqual([]);
    expect(delivered.find((r) => r.original.subject.startsWith("Invitation"))!.events).toHaveLength(
      1,
    );
  });

  it("never looks for events in mail that is not important", async () => {
    const { llm, delivered } = await run(["meeting-teams"], { gatekeeper: () => promotion() });
    expect(delivered).toHaveLength(0);
    expect(llm.callsFor("scheduler")).toBe(0);
  });

  it("shows event fields from a hostile email as plain text", async () => {
    const { delivered } = await run(["injection-event"], {
      scheduler: () => ({
        events: [
          { ...teams, title: "<img src=x onerror=alert(1)>", meeting_url: "http://evil.example" },
        ],
      }),
    });
    const html = renderEmail(delivered[0]!).html;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // The excerpt quotes the email, but no link points there.
    expect(html).not.toMatch(/href="[^"]*evil\.example/);
  });
});
