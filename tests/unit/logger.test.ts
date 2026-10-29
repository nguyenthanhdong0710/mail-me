import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { GrantTokenProvider } from "../../src/auth/tokens.js";
import { createLogger } from "../../src/lib/logger.js";
import { MemoryGrants, sampleGrant } from "../fakes/grants.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

describe("logger", () => {
  it("redacts secret-looking fields", () => {
    const { lines, stream } = capture();
    const log = createLogger({}, stream);
    log.info({ imap: { password: "hunter2-pass" }, apiKey: "k-123456" }, "connect");
    const out = lines.join("");
    expect(out).not.toContain("hunter2-pass");
    expect(out).not.toContain("k-123456");
    expect(out).toContain("[REDACTED]");
  });

  it("scrubs known secret values anywhere in the output", () => {
    const { lines, stream } = capture();
    const log = createLogger({ secrets: ["123456:telegram-secret"] }, stream);
    log.error(
      {
        err: new Error(
          "POST https://api.telegram.org/bot123456:telegram-secret/sendMessage failed",
        ),
      },
      "delivery failed",
    );
    const out = lines.join("");
    expect(out).not.toContain("telegram-secret");
    expect(out).toContain("bot[REDACTED]/sendMessage");
  });

  it("scrubs secrets added after the logger was created", () => {
    const { lines, stream } = capture();
    const secrets = new Set<string>();
    const log = createLogger({ secrets }, stream);
    secrets.add("ya29.fresh-access-token");
    log.warn({ refreshToken: "1//refresh-xyz" }, "token endpoint said ya29.fresh-access-token");
    const out = lines.join("");
    expect(out).not.toContain("ya29.fresh-access-token");
    expect(out).not.toContain("1//refresh-xyz");
  });

  it("never prints OAuth tokens or the client secret obtained through a refresh", async () => {
    const { lines, stream } = capture();
    const secrets = new Set<string>(["GOCSPX-client-secret"]);
    const log = createLogger({ secrets }, stream);
    const store = new MemoryGrants();
    store.files.set("school.read", sampleGrant({ refreshToken: "1//refresh-token-abc" }));
    const tokens = new GrantTokenProvider(
      { name: "school.read", fixCommand: "mail-me auth school" },
      store,
      {
        provider: "google",
        signIn: () => Promise.reject(new Error("unused")),
        refresh: async () => ({
          accessToken: "ya29.access-token-xyz",
          refreshToken: "1//rotated-token-def",
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      },
      { addSecret: (v) => secrets.add(v) },
    );
    const token = await tokens.accessToken();
    // Simulate the worst case: tokens end up inside error messages.
    log.error(
      { err: new Error(`401 for Bearer ${token}`) },
      "call failed with 1//refresh-token-abc",
    );
    log.warn({ detail: "rotated 1//rotated-token-def using GOCSPX-client-secret" }, "refresh");
    const out = lines.join("");
    for (const secret of [
      "ya29.access-token-xyz",
      "1//refresh-token-abc",
      "1//rotated-token-def",
      "GOCSPX-client-secret",
    ]) {
      expect(out).not.toContain(secret);
    }
  });
});
