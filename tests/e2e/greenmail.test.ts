import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountConfig } from "../../src/config/load.js";
import { EmailChannel } from "../../src/courier/channels/email/smtp-channel.js";
import { imapSourceFactory } from "../../src/fetcher/imap-source.js";
import { createLogger } from "../../src/lib/logger.js";
import { Pipeline } from "../../src/orchestrator/pipeline.js";
import { runOnce } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { testConfig } from "../fakes/config.js";
import { FakeClock, FakeLlm } from "../fakes/index.js";
import { fixture } from "../fixtures/load.js";

// Real IMAP + SMTP against GreenMail, with a fake LLM. Run with `npm run test:e2e`:
//   docker run -d --name mailme-greenmail -p 3025:3025 -p 3143:3143 \
//     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap
//       -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users.login=email
//       -Dgreenmail.users=student:secret@university.edu,me:secret@primary.example' \
//     greenmail/standalone:2.1.3

const HOST = process.env.GREENMAIL_HOST ?? "127.0.0.1";
const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true });

async function withMailbox<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: HOST,
    port: 3143,
    secure: false,
    auth: { user, pass: "secret" },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen("INBOX");
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function messages(user: string) {
  return withMailbox(user, async (c) => {
    const out: Array<{ uid: number; flags: string[]; subject: string; source: string }> = [];
    if (!c.mailbox || c.mailbox.exists === 0) return out;
    for await (const m of c.fetch("1:*", {
      uid: true,
      flags: true,
      envelope: true,
      source: true,
    })) {
      out.push({
        uid: m.uid,
        flags: [...(m.flags ?? [])],
        subject: m.envelope?.subject ?? "",
        source: m.source?.toString() ?? "",
      });
    }
    return out;
  });
}

describe.skipIf(!process.env.E2E)("e2e: GreenMail IMAP + SMTP", () => {
  const config = testConfig();
  const account: AccountConfig = {
    ...config.accounts[0]!,
    imap: {
      host: HOST,
      port: 3143,
      secure: false,
      user: "student@university.edu",
      password: "secret",
    },
  };
  const store = new SqliteStore(":memory:");
  const llm = new FakeLlm();
  const channel = new EmailChannel(
    {
      to: "me@primary.example",
      from: "Mail-Me <me@primary.example>",
      smtp: { ...config.delivery.email!.smtp },
    },
    store.getInstallId(),
    smtp,
  );
  const pipeline = new Pipeline({
    config: { ...config, accounts: [account] },
    store,
    llm,
    channels: new Map([["email", channel]]),
    sources: imapSourceFactory([account]),
    clock: new FakeClock(),
    logger: createLogger({ level: "silent" }),
    retry: { attempts: 2, sleep: async () => {} },
  });
  const poll = () => runOnce(pipeline, [account], createLogger({ level: "silent" }));

  beforeAll(async () => {
    await poll(); // baseline
  });
  afterAll(() => store.close());

  it("reads a real mailbox and sends the report over SMTP", async () => {
    await smtp.sendMail({
      envelope: { from: "prof.nguyen@university.edu", to: ["student@university.edu"] },
      raw: fixture("important-deadline.eml"),
    });
    await poll();

    const reports = await messages("me@primary.example");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.subject).toBe("[AI Summary] Assignment 3 due Friday");
    expect(reports[0]!.source).toMatch(/X-Mail-Me: report; v=1; id=[0-9a-f-]{36}/);
    expect(reports[0]!.source).toContain("Auto-Submitted: auto-generated");
  });

  it("leaves the source mailbox untouched (FR-013)", async () => {
    const inbox = await messages("student@university.edu");
    expect(inbox.length).toBeGreaterThan(0);
    for (const m of inbox) expect(m.flags).not.toContain("\\Seen");
  });

  it("skips its own report when it lands in a monitored mailbox (FR-022)", async () => {
    const [report] = await messages("me@primary.example");
    await smtp.sendMail({
      envelope: { from: "me@primary.example", to: ["student@university.edu"] },
      raw: report!.source,
    });
    const before = llm.calls.length;
    await poll();
    expect(llm.calls.length).toBe(before);
    expect(await messages("me@primary.example")).toHaveLength(1);
  });

  it("does not resend after a restart", async () => {
    const restarted = new Pipeline({
      config: { ...config, accounts: [account] },
      store,
      llm,
      channels: new Map([["email", channel]]),
      sources: imapSourceFactory([account]),
      clock: new FakeClock(),
      logger: createLogger({ level: "silent" }),
    });
    await runOnce(restarted, [account], createLogger({ level: "silent" }));
    expect(await messages("me@primary.example")).toHaveLength(1);
  });
});
