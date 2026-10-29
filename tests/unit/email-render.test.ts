import { describe, expect, it } from "vitest";
import { renderEmail } from "../../src/courier/channels/email/render.js";
import { classifySmtpError, reportHeaders } from "../../src/courier/channels/email/smtp-channel.js";
import type { Report } from "../../src/domain/types.js";
import { analysis } from "../fakes/index.js";

const base: Report = {
  key: { accountId: "school", uidValidity: 1, uid: 5 },
  source: { accountId: "school", label: "School" },
  original: {
    messageId: "<orig@university.edu>",
    from: { name: "Prof. Nguyen", address: "prof@university.edu" },
    subject: "Assignment 3",
    receivedAt: "2026-10-28T02:15:00.000Z",
  },
  kind: "SUMMARY",
  analysis: analysis(),
  excerpt: "Please submit before Friday 5pm.",
  truncated: false,
  urgent: false,
  actionNeeded: true,
};

describe("renderEmail", () => {
  it("renders a summary report", () => {
    const r = renderEmail(base);
    expect(r.subject).toBe("[AI Summary] Assignment 3");
    expect(r.html).toContain("📥 <b>School</b>");
    expect(r.html).toContain("Prof. Nguyen &lt;prof@university.edu&gt;");
    expect(r.html).toContain("<b>TL;DR:</b> Bài tập 3");
    expect(r.html).toContain("☐ Nộp bài tập 3 — <i>Thứ Sáu 17:00</i>");
    expect(r.html).toContain("<b>Action needed:</b> Yes");
    expect(r.html).toContain("--- Original excerpt ---");
    expect(r.text).toContain("[ ] Nộp bài tập 3 — Thứ Sáu 17:00");
    expect(r.text).toContain("Action needed: Yes");
  });

  it("escapes content from the email and the AI", () => {
    const r = renderEmail({
      ...base,
      original: { ...base.original, subject: "<script>alert(1)</script>" },
      analysis: analysis({ summary: `<img src=x onerror="steal()">` }),
      excerpt: "a & b < c",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("a &amp; b &lt; c");
  });

  it("marks urgent reports", () => {
    const r = renderEmail({ ...base, urgent: true });
    expect(r.subject).toBe("🔴 [AI Summary] Assignment 3");
    expect(r.html).toContain("Needs immediate attention");
  });

  it("renders the fallback report", () => {
    const r = renderEmail({ ...base, kind: "FALLBACK", analysis: null, actionNeeded: false });
    expect(r.subject).toBe("[Not summarized] Assignment 3");
    expect(r.html).toContain("AI summary unavailable");
    expect(r.html).toContain("Please submit before Friday 5pm.");
    expect(r.html).not.toContain("TL;DR");
  });

  it("notes truncated content", () => {
    expect(renderEmail({ ...base, truncated: true }).text).toContain("(content truncated");
  });
});

describe("report headers", () => {
  it("adds the self-sent marker and threads with the original", () => {
    const h = reportHeaders(base, "1234-abcd");
    expect(h["X-Mail-Me"]).toBe("report; v=1; id=1234-abcd");
    expect(h["Auto-Submitted"]).toBe("auto-generated");
    expect(h["X-Mail-Me-Source"]).toBe("School");
    expect(h["In-Reply-To"]).toBe("<orig@university.edu>");
  });
});

describe("classifySmtpError", () => {
  it("does not retry auth failures or permanent rejections", () => {
    expect(classifySmtpError({ code: "EAUTH", message: "bad login" }).retryable).toBe(false);
    expect(classifySmtpError({ responseCode: 550, message: "no such user" }).retryable).toBe(false);
    expect(classifySmtpError({ code: "ECONNECTION", message: "timeout" }).retryable).toBe(true);
    expect(classifySmtpError({ responseCode: 421, message: "try later" }).retryable).toBe(true);
  });
});
