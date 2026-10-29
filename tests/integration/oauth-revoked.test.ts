import { describe, expect, it } from "vitest";
import {
  GrantRevokedError,
  type MailSource,
  type MailSourceFactory,
} from "../../src/domain/ports.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/poller.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeChannel, FakeClock, FakeLlm, FakeMailServer } from "../fakes/index.js";
import { eml } from "../fixtures/load.js";
import { Writable } from "node:stream";

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, logger: createLogger({ level: "info" }, stream) };
}

/** Wraps a fake mail server so one account's grant can be revoked and restored. */
function withRevocation(server: FakeMailServer, accountId: string) {
  const state = { revoked: false };
  const inner = server.factory();
  const factory: MailSourceFactory = (id) => {
    const src = inner(id);
    if (id !== accountId) return src;
    const guard = <T>(fn: () => T): T => {
      if (state.revoked)
        throw new GrantRevokedError(`${id}.read`, `mail-me auth ${id}`, "invalid_grant");
      return fn();
    };
    const wrapped: MailSource = {
      open: (m) => guard(() => src.open(m)),
      fetchSince: (c, l) => guard(() => src.fetchSince(c, l)),
      cursorSince: (s) => src.cursorSince(s),
      close: () => src.close(),
    };
    return wrapped;
  };
  return { state, factory };
}

describe("revoked OAuth grant (US1-5, FR-104)", () => {
  it("logs the fix, keeps other accounts working, and skips no mail after signing in again", async () => {
    const config = testConfig((raw) => {
      const accounts = raw.accounts as Array<Record<string, unknown>>;
      accounts.push({
        id: "work",
        email: "me@work.example",
        imap: { host: "imap.work.example", password_env: "SCHOOL_IMAP_PASSWORD" },
      });
    });
    const server = new FakeMailServer();
    const { state, factory } = withRevocation(server, "school");
    const store = new SqliteStore(":memory:");
    const channel = new FakeChannel("email");
    const { lines, logger } = capture();
    const pipeline = new Pipeline({
      config,
      store,
      llm: new FakeLlm(),
      channels: new Map([["email", channel]]),
      sources: factory,
      clock: new FakeClock(),
      logger,
      retry: { attempts: 1, sleep: async () => {} },
    });
    const poll = () => runOnce(pipeline, config.accounts, logger);

    await poll(); // baseline both mailboxes
    state.revoked = true;
    server.deliver("school", eml({ subject: "Exam moved" }));
    server.deliver("work", eml({ subject: "Standup notes" }));
    await poll();

    expect(channel.delivered.map((r) => r.original.subject)).toEqual(["Standup notes"]);
    const revokedLine = lines.find((l) => l.fix === "mail-me auth school");
    expect(revokedLine?.msg).toBe("sign-in revoked or expired, run mail-me auth school");
    expect(store.getMailboxState("school", "INBOX")?.cursor).toBe("0");

    state.revoked = false; // the user ran `mail-me auth school`
    await poll();
    await poll();
    expect(channel.delivered.map((r) => r.original.subject)).toEqual([
      "Standup notes",
      "Exam moved",
    ]);
  });
});
