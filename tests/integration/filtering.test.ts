import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/load.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/poller.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer } from "../fakes/index.js";
import { eml, fixture } from "../fixtures/load.js";

const logger = createLogger({ level: "silent" });
const fast = { attempts: 2, sleep: async () => {} };

/** Gatekeeper stand-in that classifies by the sender domain of the fixture. */
function scriptedGatekeeper({ user }: { user: string }) {
  if (user.includes("secure-login.example"))
    return { category: "SPAM", confidence_score: 0.95, reasoning: "Credential phishing" };
  if (user.includes("shopnow.example"))
    return { category: "PROMOTION", confidence_score: 0.9, reasoning: "Marketing" };
  if (user.includes("random.example"))
    return { category: "SPAM", confidence_score: 0.9, reasoning: "Unsolicited, manipulative" };
  return { category: "IMPORTANT", confidence_score: 0.9, reasoning: "Direct message" };
}

describe("filtering (US2)", () => {
  let server: FakeMailServer;
  let store: SqliteStore;
  let llm: FakeLlm;
  let channel: FakeChannel;
  let config: AppConfig;

  const poll = () =>
    runOnce(
      new Pipeline({
        config,
        store,
        llm,
        channels: new Map([["email", channel]]),
        sources: server.factory(),
        clock: new FakeClock(),
        logger,
        retry: fast,
      }),
      config.accounts,
      logger,
    );
  const key = (uid: string) => ({ accountId: "school", mailbox: "INBOX", uidValidity: "1", uid });

  beforeEach(async () => {
    server = new FakeMailServer();
    store = new SqliteStore(":memory:");
    llm = new FakeLlm({ gatekeeper: scriptedGatekeeper });
    channel = new FakeChannel("email");
    config = testConfig((c) => {
      c.rules = { whitelist_domains: ["university.edu"], drop_keywords: ["discount"] };
    });
    await poll();
  });

  it("forwards only the important email out of promo, phishing and important", async () => {
    config = testConfig(); // no rules: everything goes through the Gatekeeper
    const promo = server.deliver("school", fixture("promo.eml"));
    const phish = server.deliver("school", fixture("phishing.eml"));
    server.deliver("school", eml({ from: "Bob <bob@friend.example>", subject: "Dinner?" }));
    await poll();

    expect(channel.delivered.map((r) => r.original.subject)).toEqual(["Dinner?"]);
    expect(store.getProcessed(key(promo))).toMatchObject({
      decision: "LLM",
      category: "PROMOTION",
      outcome: "SKIPPED",
    });
    expect(store.getProcessed(key(phish))).toMatchObject({
      decision: "LLM",
      category: "SPAM",
      outcome: "SKIPPED",
    });
    expect(llm.callsFor("analyst")).toBe(1);
  });

  it("drops a keyword hit without calling the AI (SC-007)", async () => {
    const uid = server.deliver("school", fixture("promo.eml")); // "50% discount" in the subject
    await poll();
    expect(llm.calls).toHaveLength(0);
    expect(channel.delivered).toHaveLength(0);
    expect(store.getProcessed(key(uid))).toMatchObject({
      decision: "DROP_KEYWORD",
      category: "PROMOTION",
      outcome: "SKIPPED",
    });
  });

  it("forwards a whitelisted sender without calling the Gatekeeper", async () => {
    // Would be dropped by the keyword, but the whitelist comes first.
    const uid = server.deliver(
      "school",
      eml({ from: "Bookstore <shop@store.university.edu>", subject: "Student discount on books" }),
    );
    await poll();
    expect(llm.callsFor("gatekeeper")).toBe(0);
    expect(llm.callsFor("analyst")).toBe(1);
    expect(channel.delivered).toHaveLength(1);
    expect(store.getProcessed(key(uid))).toMatchObject({
      decision: "WHITELIST",
      category: "IMPORTANT",
      outcome: "FORWARDED",
    });
  });

  it("keeps routing in code when the email tries to inject instructions", async () => {
    const uid = server.deliver("school", fixture("injection.eml"));
    await poll();

    // The email cannot close our data block: the literal </email> is neutralized.
    const prompt = llm.calls.find((c) => c.role === "gatekeeper")!.user;
    expect(prompt.match(/<\/email>/g)).toHaveLength(1);
    expect(prompt.trimEnd().endsWith("</email>")).toBe(true);

    // The scripted verdict stands; the injected text changed nothing.
    expect(channel.delivered).toHaveLength(0);
    expect(store.getProcessed(key(uid))).toMatchObject({ category: "SPAM", outcome: "SKIPPED" });
  });

  it("forwards an injection email that the model wrongly calls IMPORTANT, but still as data", async () => {
    llm.handlers.gatekeeper = () => ({
      category: "IMPORTANT",
      confidence_score: 1,
      reasoning: "x",
    });
    server.deliver("school", fixture("injection.eml"));
    await poll();
    expect(channel.delivered).toHaveLength(1);
    // The analyst output is schema-checked; the report is built from it and the excerpt only.
    expect(channel.delivered[0]!.kind).toBe("SUMMARY");
  });
});
