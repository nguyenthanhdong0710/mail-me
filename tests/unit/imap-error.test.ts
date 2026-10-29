import { describe, expect, it } from "vitest";
import { describeImapError } from "../../src/fetcher/imap-source.js";

describe("describeImapError", () => {
  it("puts the server's reason in the message", () => {
    const err = Object.assign(new Error("Command failed"), {
      serverResponseCode: "AUTHENTICATIONFAILED",
      responseText: "Invalid credentials (Failure)",
    });
    const described = describeImapError(err) as Error;
    expect(described.message).toBe("IMAP AUTHENTICATIONFAILED: Invalid credentials (Failure)");
    expect(described.cause).toBe(err);
  });

  it("leaves errors without a server response alone", () => {
    const err = new Error("connect ECONNREFUSED");
    expect(describeImapError(err)).toBe(err);
  });
});
