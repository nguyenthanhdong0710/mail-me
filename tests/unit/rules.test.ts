import { describe, expect, it } from "vitest";
import type { IncomingEmail } from "../../src/domain/types.js";
import {
  evaluateRules,
  matchDropKeyword,
  matchWhitelist,
  type RuleConfig,
} from "../../src/rules/engine.js";

const INSTALL_ID = "0b6f7c1e-2f4a-4b8e-9d3c-5a1e2f3b4c5d";

function email(overrides: Partial<IncomingEmail> = {}): IncomingEmail {
  return {
    accountId: "school",
    uidValidity: "1",
    uid: "1",
    mailbox: "INBOX",
    messageId: "<m@test>",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ address: "student@university.edu" }],
    cc: [],
    deliveredTo: "student@university.edu",
    addressedToYou: true,
    webLink: null,
    subject: "Hello",
    receivedAt: new Date("2026-10-28T09:00:00Z"),
    sentAt: "2026-10-28T09:00:00.000Z",
    calendarParts: [],
    text: "Body",
    truncated: false,
    attachments: [],
    selfSentMarker: null,
    ...overrides,
  };
}

const rules = (r: Partial<RuleConfig> = {}): RuleConfig => ({
  whitelistDomains: [],
  dropKeywords: [],
  ...r,
});

const evaluate = (e: IncomingEmail, r: Partial<RuleConfig> = {}, processed = false) =>
  evaluateRules(e, { installId: INSTALL_ID, isProcessed: () => processed, rules: rules(r) });

describe("whitelist", () => {
  it("matches the exact domain and its subdomains", () => {
    expect(matchWhitelist("prof@university.edu", ["university.edu"])).toBe("university.edu");
    expect(matchWhitelist("x@cs.university.edu", ["university.edu"])).toBe("university.edu");
  });

  it("does not match look-alike domains", () => {
    expect(matchWhitelist("x@evil-university.edu", ["university.edu"])).toBeNull();
    expect(matchWhitelist("x@university.edu.evil.com", ["university.edu"])).toBeNull();
  });

  it("strips a leading @ and ignores case", () => {
    expect(matchWhitelist("Prof@University.EDU", ["@university.edu"])).toBe("university.edu");
    expect(matchWhitelist("prof@university.edu", ["@University.Edu"])).toBe("university.edu");
  });

  it("returns WHITELIST from the engine", () => {
    const e = email({ from: { address: "dean@cs.university.edu" } });
    expect(evaluate(e, { whitelistDomains: ["university.edu"] })).toEqual({
      kind: "WHITELIST",
      domain: "university.edu",
    });
  });
});

describe("drop keywords", () => {
  it("matches the subject case-insensitively", () => {
    expect(matchDropKeyword(email({ subject: "Big SALE today" }), ["sale"])).toBe("sale");
  });

  it("matches the sender name or address", () => {
    expect(
      matchDropKeyword(email({ from: { name: "Discount Club", address: "a@b.c" } }), ["discount"]),
    ).toBe("discount");
    expect(
      matchDropKeyword(email({ from: { address: "newsletter@shop.example" } }), ["newsletter"]),
    ).toBe("newsletter");
  });

  it("never matches the body", () => {
    expect(matchDropKeyword(email({ text: "huge sale inside" }), ["sale"])).toBeNull();
    expect(evaluate(email({ text: "huge sale inside" }), { dropKeywords: ["sale"] })).toEqual({
      kind: "NEEDS_LLM",
    });
  });

  it("matches whole words only", () => {
    expect(matchDropKeyword(email({ subject: "Wholesale pricing" }), ["sale"])).toBeNull();
    expect(matchDropKeyword(email({ subject: "Salesforce report" }), ["sale"])).toBeNull();
    expect(matchDropKeyword(email({ subject: "sale!" }), ["sale"])).toBe("sale");
  });

  it("handles keywords that start with punctuation", () => {
    expect(matchDropKeyword(email({ subject: "Flash sale: 50% off" }), ["% off"])).toBe("% off");
  });

  it("works with non-Latin text", () => {
    expect(matchDropKeyword(email({ subject: "Khuyến mãi lớn" }), ["khuyến mãi"])).toBe(
      "khuyến mãi",
    );
  });

  it("treats regex characters literally", () => {
    expect(matchDropKeyword(email({ subject: "a.b" }), ["a+b"])).toBeNull();
    expect(matchDropKeyword(email({ subject: "deal (today)" }), ["(today)"])).toBe("(today)");
  });
});

describe("rule precedence", () => {
  const all = { whitelistDomains: ["example.com"], dropKeywords: ["sale"] };

  it("already processed wins over everything", () => {
    expect(evaluate(email({ subject: "sale" }), all, true)).toEqual({ kind: "ALREADY_PROCESSED" });
  });

  it("self-sent wins over whitelist and keywords", () => {
    const e = email({ subject: "sale", selfSentMarker: `report; v=1; id=${INSTALL_ID}` });
    expect(evaluate(e, all)).toEqual({ kind: "SELF_SENT" });
  });

  it("whitelist wins over drop keywords", () => {
    expect(evaluate(email({ subject: "Bookstore sale" }), all).kind).toBe("WHITELIST");
  });

  it("falls through to the LLM when nothing matches", () => {
    expect(evaluate(email({ from: { address: "x@other.org" } }), all)).toEqual({
      kind: "NEEDS_LLM",
    });
  });
});
