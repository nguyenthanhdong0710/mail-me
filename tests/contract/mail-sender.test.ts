import { describe, expect, it } from "vitest";
import { buildMime, EmailChannel } from "../../src/courier/channels/email/email-channel.js";
import { GmailApiSender, GraphSender } from "../../src/courier/channels/email/senders.js";
import { ChannelError, GrantRevokedError, type TokenProvider } from "../../src/domain/ports.js";
import { ApiClient } from "../../src/lib/api-client.js";
import { FakeApi } from "../fakes/http.js";
import { sampleReport } from "../fakes/index.js";

const revokedRef = { name: "email-channel.send", fixCommand: "mail-me auth --email-channel" };

function tokens(fail = false): TokenProvider & { calls: number } {
  const t = {
    calls: 0,
    accessToken: async () => {
      t.calls++;
      if (fail) throw new GrantRevokedError(revokedRef.name, revokedRef.fixCommand);
      return "token";
    },
    invalidate: () => {},
  };
  return t;
}

const cfg = { from: "Mail-Me <me@gmail.com>", to: "reports@example.com" };

describe("GmailApiSender (gmail.send)", () => {
  it("posts the raw MIME, keeping our headers", async () => {
    const api = new FakeApi().on("POST", /gmail\/v1\/users\/me\/messages\/send$/, {
      json: { id: "18f0" },
    });
    const t = tokens();
    const channel = new EmailChannel(
      cfg,
      "install-1",
      new GmailApiSender(new ApiClient(api.fetch, t, revokedRef, "gmail"), t),
    );
    expect(await channel.deliver(sampleReport())).toEqual({ externalId: "18f0" });
    const raw = Buffer.from(
      (JSON.parse(api.calls[0]!.body) as { raw: string }).raw,
      "base64url",
    ).toString();
    expect(raw).toContain("X-Mail-Me: report; v=1; id=install-1");
    expect(raw).toContain("In-Reply-To: <orig@university.edu>");
    expect(raw).toContain("References: <orig@university.edu>");
    expect(raw).toContain("To: reports@example.com");
  });

  it("retries a revoked sending grant after the user signs in again", async () => {
    const api = new FakeApi().on("POST", /messages\/send$/, { status: 401, json: {} });
    const sender = new GmailApiSender(
      new ApiClient(api.fetch, tokens(), revokedRef, "gmail"),
      tokens(),
    );
    const { mime } = await buildMime(sampleReport(), cfg, "i");
    const err = (await sender.send(mime).catch((e) => e)) as ChannelError;
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("run `mail-me auth --email-channel`");
  });

  it("verifies by refreshing, without sending", async () => {
    const api = new FakeApi();
    const t = tokens();
    await new GmailApiSender(new ApiClient(api.fetch, t, revokedRef, "gmail"), t).verify();
    expect(t.calls).toBe(1);
    expect(api.calls).toHaveLength(0);
    const dead = tokens(true);
    await expect(
      new GmailApiSender(new ApiClient(api.fetch, dead, revokedRef, "gmail"), dead).verify(),
    ).rejects.toBeInstanceOf(ChannelError);
  });
});

describe("GraphSender (Mail.Send)", () => {
  it("posts base64 MIME to /me/sendMail and reports our Message-ID", async () => {
    const api = new FakeApi().on("POST", /graph\.microsoft\.com\/v1\.0\/me\/sendMail$/, {
      status: 202,
      text: "",
    });
    const t = tokens();
    const channel = new EmailChannel(
      cfg,
      "install-1",
      new GraphSender(new ApiClient(api.fetch, t, revokedRef, "graph"), t),
    );
    const { externalId } = await channel.deliver(sampleReport());
    expect(externalId).toMatch(/^<.+@.+>$/);
    const call = api.calls[0]!;
    expect(call.headers["content-type"]).toBe("text/plain");
    const mime = Buffer.from(call.body, "base64").toString();
    expect(mime).toContain(`Message-ID: ${externalId}`);
    expect(mime).toContain("X-Mail-Me: report; v=1; id=install-1");
  });

  it("maps throttling to a retryable error with Retry-After", async () => {
    const api = new FakeApi().on("POST", /sendMail$/, {
      status: 429,
      json: { error: { code: "ApplicationThrottled", message: "slow" } },
      headers: { "retry-after": "30" },
    });
    const sender = new GraphSender(
      new ApiClient(api.fetch, tokens(), revokedRef, "graph"),
      tokens(),
    );
    const err = (await sender.send(Buffer.from("x"), {}).catch((e) => e)) as ChannelError;
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("does not retry a permanent rejection", async () => {
    const api = new FakeApi().on("POST", /sendMail$/, {
      status: 403,
      json: { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
    });
    const sender = new GraphSender(
      new ApiClient(api.fetch, tokens(), revokedRef, "graph"),
      tokens(),
    );
    const err = (await sender.send(Buffer.from("x"), {}).catch((e) => e)) as ChannelError;
    expect(err.retryable).toBe(false);
  });
});
