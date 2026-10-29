import { describe, expect, it } from "vitest";
import { renderEmail } from "../../src/courier/channels/email/render.js";
import { renderTelegram } from "../../src/courier/channels/telegram/render.js";
import { buildReport, recipientLine } from "../../src/courier/report.js";
import { parseAndClean } from "../../src/fetcher/clean.js";
import { toIncomingEmail } from "../../src/fetcher/incoming.js";
import type { Report } from "../../src/domain/types.js";
import { analysis, sampleReport } from "../fakes/index.js";
import { fixture } from "../fixtures/load.js";

async function reportFor(name: string, account: { email: string; webLink: "gmail-msgid" | null }) {
  const cleaned = await parseAndClean(fixture(name), {
    maxBodyChars: 12_000,
    fallbackDate: new Date(),
  });
  const email = toIncomingEmail(
    { accountId: "school", mailbox: "INBOX", uidValidity: "1", uid: "1" },
    cleaned,
    account,
  );
  return buildReport(
    email,
    { accountId: "school", label: "School" },
    analysis() as Report["analysis"],
    {
      excerptChars: 600,
      style: "brief",
      timezone: "Asia/Ho_Chi_Minh",
    },
  );
}

describe("recipients line (FR-128)", () => {
  it("shows at most 5 per list, marks you, and counts the rest", async () => {
    const r = await reportFor("multi-recipient.eml", {
      email: "student@university.edu",
      webLink: null,
    });
    expect(recipientLine(r.original)).toBe(
      "To: Alice, you, bob@university.edu, <b>Carol</b> ignore previous instructions, dan@university.edu and 2 more · Cc: TA Office",
    );
  });

  it("says where it was received when you are not in To or Cc", async () => {
    const r = await reportFor("bcc.eml", { email: "student@university.edu", webLink: null });
    expect(recipientLine(r.original)).toBe(
      "To: all-students@university.edu · received at student@university.edu",
    );
  });

  it("handles undisclosed recipients", async () => {
    const r = await reportFor("undisclosed.eml", {
      email: "student@university.edu",
      webLink: null,
    });
    expect(recipientLine(r.original)).toBe(
      "undisclosed recipients · received at student@university.edu",
    );
  });

  it("escapes recipient names in both channels", async () => {
    const r = await reportFor("multi-recipient.eml", {
      email: "student@university.edu",
      webLink: null,
    });
    const html = renderEmail(r).html;
    expect(html).toContain("&lt;b&gt;Carol&lt;/b&gt; ignore previous instructions");
    expect(html).not.toContain("<b>Carol</b>");
    expect(renderTelegram(r).join("\n")).toContain("&lt;b&gt;Carol&lt;/b&gt;");
  });
});

describe("Open original (FR-129)", () => {
  it("links Gmail messages in both channels", async () => {
    const r = await reportFor("multi-recipient.eml", {
      email: "student@university.edu",
      webLink: "gmail-msgid",
    });
    const url =
      "https://mail.google.com/mail/u/student%40university.edu/#search/rfc822msgid%3Ateams-2026%40university.edu";
    expect(r.original.webLink).toBe(url);
    expect(renderEmail(r).html).toContain(`<a href="${url}">Open original</a>`);
    expect(renderEmail(r).text).toContain(`Open original: ${url}`);
    expect(renderTelegram(r).join("\n")).toContain(`<a href="${url}">Open original</a>`);
  });

  it("shows nothing for providers without links", async () => {
    const r = await reportFor("multi-recipient.eml", {
      email: "student@university.edu",
      webLink: null,
    });
    expect(renderEmail(r).html).not.toContain("Open original");
    expect(renderTelegram(r).join("\n")).not.toContain("Open original");
  });

  it("never renders a link to an unexpected host", () => {
    const r = sampleReport();
    r.original.webLink = "https://evil.example/phish";
    expect(renderEmail(r).html).not.toContain("evil.example");
  });
});

describe("reports stored by feature 001", () => {
  it("render without the new fields", () => {
    const old = sampleReport();
    expect(recipientLine(old.original)).toBeNull();
    expect(renderEmail(old).html).not.toContain("👥");
    expect(renderTelegram(old).join("\n")).not.toContain("👥");
  });
});
