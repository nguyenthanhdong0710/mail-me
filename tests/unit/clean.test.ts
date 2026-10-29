import { describe, expect, it } from "vitest";
import {
  normalizeWhitespace,
  parseAndClean,
  stripQuotedReplies,
  truncate,
} from "../../src/fetcher/clean.js";
import { eml, fixture } from "../fixtures/load.js";

const opts = { maxBodyChars: 12000, fallbackDate: new Date("2026-10-29T00:00:00Z") };

describe("parseAndClean", () => {
  it("extracts headers and strips the quoted reply chain", async () => {
    const e = await parseAndClean(fixture("important-deadline.eml"), opts);
    expect(e.from).toEqual({ name: "Prof. Nguyen", address: "prof.nguyen@university.edu" });
    expect(e.subject).toBe("Assignment 3 due Friday");
    expect(e.messageId).toBe("<assignment3-0001@university.edu>");
    expect(e.text).toContain("before Friday 5pm");
    expect(e.text).not.toContain("When is assignment 3 due");
    expect(e.text).not.toContain("wrote:");
    expect(e.truncated).toBe(false);
  });

  it("converts HTML-only mail to text", async () => {
    const e = await parseAndClean(fixture("promo.eml"), opts);
    expect(e.text).toContain("Flash sale");
    expect(e.text).toContain("50% off");
    expect(e.text).not.toMatch(/<\/?(p|b|h1|html)>/);
  });

  it("decodes encoded Vietnamese headers", async () => {
    const e = await parseAndClean(fixture("vietnamese.eml"), opts);
    expect(e.subject).toBe("Thông báo lịch thi");
    expect(e.from.name).toBe("Phòng Đào tạo");
    expect(e.text).toContain("Lịch thi cuối kỳ");
  });

  it("truncates huge HTML bodies and drops <style>", async () => {
    const e = await parseAndClean(fixture("huge-html.eml"), { ...opts, maxBodyChars: 2000 });
    expect(e.truncated).toBe(true);
    expect(e.text.length).toBeLessThanOrEqual(2000);
    expect(e.text).toContain("weekly metrics");
    expect(e.text).not.toContain("color: red");
  });

  it("lists attachment names when there is no body", async () => {
    const e = await parseAndClean(fixture("no-body-attachment.eml"), opts);
    expect(e.text).toBe("");
    expect(e.attachments).toEqual(["contract.pdf"]);
  });

  it("reads the self-sent marker header", async () => {
    const e = await parseAndClean(
      Buffer.from(eml({ headers: { "X-Mail-Me": "report; v=1; id=abc" } })),
      opts,
    );
    expect(e.selfSentMarker).toBe("report; v=1; id=abc");
  });

  it("uses a placeholder for an empty subject", async () => {
    const e = await parseAndClean(Buffer.from(eml({ subject: "" })), opts);
    expect(e.subject).toBe("(no subject)");
  });
});

describe("text helpers", () => {
  it("removes > quoted lines and Outlook-style headers", () => {
    expect(stripQuotedReplies("Hi\n> old\nThanks")).toBe("Hi\nThanks");
    expect(stripQuotedReplies("New text\n-----Original Message-----\nold")).toBe("New text\n");
  });

  it("collapses whitespace", () => {
    expect(normalizeWhitespace("a   b  \n\n\n\nc\r\n")).toBe("a b\n\nc");
  });

  it("does not split a surrogate pair", () => {
    const r = truncate("ab😀cd", 3);
    expect(r).toEqual({ text: "ab", truncated: true });
  });
});
