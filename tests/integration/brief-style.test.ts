import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRIEF_LIMITS, wordCount } from "../../src/courier/clamp.js";
import { renderEmail } from "../../src/courier/channels/email/render.js";
import { renderTelegram } from "../../src/courier/channels/telegram/render.js";
import type { Report } from "../../src/domain/types.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/poller.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer } from "../fakes/index.js";

const dir = new URL("../fixtures/emails/brief/", import.meta.url);
const answers = JSON.parse(readFileSync(new URL("analysis.json", dir), "utf8")) as Array<{
  subject: string;
  analysis: Record<string, unknown>;
}>;

async function reports(style: "brief" | "detailed"): Promise<Report[]> {
  const config = testConfig((raw) => {
    (raw.ai as Record<string, Record<string, unknown>>).analyst!.style = style;
  });
  const server = new FakeMailServer();
  const llm = new FakeLlm({
    analyst: ({ user }) =>
      answers.find((a) => user.includes(`<subject>${a.subject}</subject>`))!.analysis,
  });
  const channel = new FakeChannel("email");
  const pipeline = new Pipeline({
    config,
    store: new SqliteStore(":memory:"),
    llm,
    channels: new Map([["email", channel]]),
    sources: server.factory(),
    clock: new FakeClock(),
    logger: createLogger({ level: "silent" }),
    retry: { attempts: 1, sleep: async () => {} },
  });
  await runOnce(pipeline, config.accounts, createLogger({ level: "silent" }));
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".eml"))
    .sort()) {
    server.deliver("school", readFileSync(new URL(f, dir)));
  }
  await runOnce(pipeline, config.accounts, createLogger({ level: "silent" }));
  expect(llm.calls.filter((c) => c.role === "analyst")[0]!.system).toContain(
    style === "brief" ? "at most 2 short sentences" : "Extract the main points",
  );
  return channel.delivered;
}

describe("brief reports (US3, SC-105)", () => {
  it("meets every limit for all 20 test emails", async () => {
    const delivered = await reports("brief");
    expect(delivered).toHaveLength(20);
    for (const r of delivered) {
      const a = r.analysis!;
      expect(a.summary.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
      expect(wordCount(a.summary)).toBeLessThanOrEqual(BRIEF_LIMITS.summaryWords);
      expect(a.key_points.length).toBeLessThanOrEqual(BRIEF_LIMITS.points);
      for (const p of a.key_points)
        expect(wordCount(p)).toBeLessThanOrEqual(BRIEF_LIMITS.pointWords);
      expect(r.excerpt.length).toBeLessThanOrEqual(BRIEF_LIMITS.excerptChars + 1);
    }
  });

  it("shows 'Action needed: No' and no action section when there is nothing to do (FR-112)", async () => {
    const delivered = await reports("brief");
    const none = delivered.filter((r) => !r.actionNeeded);
    const some = delivered.filter((r) => r.actionNeeded);
    expect(none.length).toBeGreaterThan(0);
    for (const r of none) {
      const text = renderEmail(r).text;
      expect(text).toContain("Action needed: No");
      expect(text).not.toContain("Actions:");
    }
    for (const r of some) expect(renderEmail(r).text).toContain("Actions:");
  });

  it("fits at least 90% of Telegram reports in one message", async () => {
    const delivered = await reports("brief");
    const single = delivered.filter((r) => renderTelegram(r).length === 1).length;
    expect(single / delivered.length).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps the 001 format in detailed style", async () => {
    const delivered = await reports("detailed");
    const r = delivered[0]!;
    expect(r.analysis!.key_points.length).toBe(6);
    expect(r.excerpt.length).toBeGreaterThan(BRIEF_LIMITS.excerptChars);
    const text = renderEmail(r).text;
    expect(text).toContain("Key points:");
    expect(text).toMatch(/Action needed: (Yes|No)/);
  });
});
