import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/load.js";
import { renderEmail } from "../../src/courier/channels/email/render.js";
import { reportHeaders } from "../../src/courier/channels/email/email-channel.js";
import { renderTelegram } from "../../src/courier/channels/telegram/render.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/poller.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer } from "../fakes/index.js";
import { eml } from "../fixtures/load.js";

const logger = createLogger({ level: "silent" });
const fast = { attempts: 2, sleep: async () => {} };

describe("multiple accounts, both channels (US3)", () => {
  let server: FakeMailServer;
  let store: SqliteStore;
  let llm: FakeLlm;
  let email: FakeChannel;
  let telegram: FakeChannel;
  let config: AppConfig;

  const poll = () =>
    runOnce(
      new Pipeline({
        config,
        store,
        llm,
        channels: new Map([
          ["email", email],
          ["telegram", telegram],
        ]),
        sources: server.factory(),
        clock: new FakeClock(),
        logger,
        retry: fast,
      }),
      config.accounts,
      logger,
    );

  beforeEach(async () => {
    server = new FakeMailServer();
    store = new SqliteStore(":memory:");
    llm = new FakeLlm();
    email = new FakeChannel("email");
    telegram = new FakeChannel("telegram");
    config = testConfig((c) => {
      const accounts = c.accounts as Array<Record<string, unknown>>;
      accounts.push({
        id: "work",
        label: "Work",
        email: "me@company.example",
        imap: {
          host: "imap.company.example",
          user: "me@company.example",
          password_env: "SCHOOL_IMAP_PASSWORD",
        },
        mailboxes: ["INBOX", "Projects"],
      });
      (c.delivery as Record<string, unknown>).telegram = {
        enabled: true,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        chat_id: "42",
      };
    });
    await poll();
  });

  it("delivers each account's report to each channel, labelled by source", async () => {
    server.deliver("school", eml({ subject: "From school" }));
    server.deliver("work", eml({ subject: "From work" }));
    server.deliver("work", eml({ subject: "From a work folder" }), { mailbox: "Projects" });
    await poll();

    for (const ch of [email, telegram]) {
      expect(ch.delivered.map((r) => [r.source.label, r.original.subject])).toEqual([
        ["School", "From school"],
        ["Work", "From work"],
        ["Work", "From a work folder"],
      ]);
    }
    expect(llm.callsFor("analyst")).toBe(3);

    // The label shows up in both renderings (T042).
    const work = email.delivered[1]!;
    expect(renderEmail(work).html).toContain("📥 <b>Work</b>");
    expect(reportHeaders(work, "id")["X-Mail-Me-Source"]).toBe("Work");
    expect(renderTelegram(work)[0]).toContain("📥 Work · ✉️");
  });

  it("isolates a failing channel: no duplicate email, Telegram catches up, one AI call", async () => {
    telegram.failNext(2); // both in-poll attempts fail
    server.deliver("school", eml({ subject: "Deadline" }));
    await poll();
    expect(email.delivered).toHaveLength(1);
    expect(telegram.delivered).toHaveLength(0);

    await poll();
    expect(email.delivered).toHaveLength(1);
    expect(telegram.delivered).toHaveLength(1);
    expect(llm.callsFor("gatekeeper")).toBe(1);
    expect(llm.callsFor("analyst")).toBe(1);
  });

  it("keeps the other account and mailbox going when one fails (FR-017)", async () => {
    server.openFailures.set("school", new Error("IMAP auth failed"));
    server.deliver("work", eml({ subject: "Still arrives" }));
    await poll();
    expect(email.delivered.map((r) => r.original.subject)).toEqual(["Still arrives"]);
  });

  it("tracks mailbox state per account and mailbox", async () => {
    server.deliver("work", eml({ subject: "a" }));
    server.deliver("work", eml({ subject: "b" }), { mailbox: "Projects" });
    server.deliver("work", eml({ subject: "c" }), { mailbox: "Projects" });
    await poll();
    expect(store.getMailboxState("work", "INBOX")?.cursor).toBe("1");
    expect(store.getMailboxState("work", "Projects")?.cursor).toBe("2");
    expect(store.getMailboxState("school", "INBOX")?.cursor).toBe("0");
  });
});
