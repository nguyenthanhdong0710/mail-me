import { describe, expect, it } from "vitest";
import { selfSentMarker } from "../../src/courier/channels/email/smtp-channel.js";
import type { IncomingEmail } from "../../src/domain/types.js";
import { parseAndClean } from "../../src/fetcher/clean.js";
import { evaluateRules } from "../../src/rules/engine.js";
import { eml } from "../fixtures/load.js";

const OURS = "0b6f7c1e-2f4a-4b8e-9d3c-5a1e2f3b4c5d";
const THEIRS = "9f9f9f9f-0000-4000-8000-111111111111";

async function decide(headers: Record<string, string>, subject = "[AI Summary] Sale today") {
  const cleaned = await parseAndClean(
    Buffer.from(eml({ from: "Mail-Me <me@university.edu>", subject, headers })),
    { maxBodyChars: 12_000, fallbackDate: new Date() },
  );
  const email: IncomingEmail = {
    accountId: "a",
    uidValidity: 1,
    uid: 1,
    mailbox: "INBOX",
    ...cleaned,
  };
  return evaluateRules(email, {
    installId: OURS,
    isProcessed: () => false,
    // Rules that would otherwise match: the self-sent check must win.
    rules: { whitelistDomains: ["university.edu"], dropKeywords: ["sale"] },
  });
}

describe("self-sent rule (FR-022)", () => {
  it("skips a message carrying our marker before every other rule", async () => {
    expect(await decide({ "X-Mail-Me": selfSentMarker(OURS) })).toEqual({ kind: "SELF_SENT" });
  });

  it("matches the install id case-insensitively", async () => {
    expect(await decide({ "X-Mail-Me": selfSentMarker(OURS.toUpperCase()) })).toEqual({
      kind: "SELF_SENT",
    });
  });

  it("does not skip a marker from another installation", async () => {
    const d = await decide({ "X-Mail-Me": selfSentMarker(THEIRS) });
    expect(d.kind).not.toBe("SELF_SENT");
  });

  it("does not skip on Auto-Submitted alone (bills and portals set it too)", async () => {
    const d = await decide({ "Auto-Submitted": "auto-generated" }, "Your invoice");
    expect(d).toEqual({ kind: "WHITELIST", domain: "university.edu" });
  });

  it("does not skip a marker without an id", async () => {
    const d = await decide({ "X-Mail-Me": "report; v=1" });
    expect(d.kind).not.toBe("SELF_SENT");
  });

  it("still lets ALREADY_PROCESSED come first", () => {
    const email = { selfSentMarker: selfSentMarker(OURS) } as IncomingEmail;
    expect(evaluateRules(email, { installId: OURS, isProcessed: () => true })).toEqual({
      kind: "ALREADY_PROCESSED",
    });
  });
});
