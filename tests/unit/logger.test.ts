import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";

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
});
