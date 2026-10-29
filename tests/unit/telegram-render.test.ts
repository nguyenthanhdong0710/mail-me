import { describe, expect, it } from "vitest";
import {
  escapeTelegram,
  renderTelegram,
  TELEGRAM_LIMIT,
} from "../../src/courier/channels/telegram/render.js";
import { analysis, sampleReport } from "../fakes/index.js";

const ALLOWED = new Set(["b", "i", "u", "s", "a", "code", "pre", "blockquote"]);

/** Every tag is allowed and every opened tag is closed in the same message. */
function assertWellFormed(html: string): void {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    const [, closing, tag] = m;
    expect(ALLOWED.has(tag!), `tag <${tag}> is not allowed`).toBe(true);
    if (closing) expect(stack.pop()).toBe(tag);
    else stack.push(tag!);
  }
  expect(stack).toEqual([]);
}

/** Text as Telegram shows it: tags removed, entities decoded. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("renderTelegram", () => {
  it("renders a summary report in one message", () => {
    const [msg, ...rest] = renderTelegram(sampleReport());
    expect(rest).toEqual([]);
    expect(msg).toContain("<b>[AI Summary] Assignment 3</b>");
    expect(msg).toContain("📥 School · ✉️ Prof. Nguyen &lt;prof@university.edu&gt;");
    expect(msg).toContain("<b>TL;DR:</b> Bài tập 3");
    expect(msg).toContain("<b>Key points</b>\n• Bài tập 3 đã được giao");
    expect(msg).toContain("☐ Nộp bài tập 3 — <i>Thứ Sáu 17:00</i>");
    expect(msg).toContain("<b>Action needed:</b> Yes");
    expect(msg).toContain("<blockquote expandable>Please submit before Friday 5pm.</blockquote>");
    assertWellFormed(msg!);
  });

  it("marks urgent reports", () => {
    const [msg] = renderTelegram(sampleReport({ urgent: true }));
    expect(msg!.startsWith("🔴 <b>[AI Summary]")).toBe(true);
  });

  it("renders the fallback format", () => {
    const [msg] = renderTelegram(
      sampleReport({ kind: "FALLBACK", analysis: null, actionNeeded: false }),
    );
    expect(msg).toContain("<b>[Not summarized] Assignment 3</b>");
    expect(msg).toContain("⚠️ <b>AI summary unavailable</b>");
    expect(msg).toContain("<blockquote expandable>Please submit");
    expect(msg).not.toContain("TL;DR");
  });

  it("notes truncated content", () => {
    expect(renderTelegram(sampleReport({ truncated: true }))[0]).toContain(
      "(content truncated before processing)",
    );
  });

  it("escapes content from the email and the AI", () => {
    const [msg] = renderTelegram(
      sampleReport({
        original: { ...sampleReport().original, subject: "<script>alert(1)</script> & co" },
        analysis: analysis({ summary: '<a href="javascript:x">click</a>' }) as never,
        excerpt: "</blockquote><b>fake</b>",
      }),
    );
    expect(msg).not.toContain("<script>");
    expect(msg).not.toContain('<a href="javascript');
    expect(msg).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    assertWellFormed(msg!);
  });

  it("escapes only & < >", () => {
    expect(escapeTelegram(`<a> & "q" 'x'`)).toBe(`&lt;a&gt; &amp; "q" 'x'`);
  });

  it("shortens a long excerpt before splitting (step 1)", () => {
    const parts = renderTelegram(sampleReport({ excerpt: "word ".repeat(2000) }));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(parts[0]).toMatch(/…<\/blockquote>$/);
    assertWellFormed(parts[0]!);
  });

  it("counts escaped length when shortening", () => {
    const parts = renderTelegram(sampleReport({ excerpt: "<&>".repeat(2000) }));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(parts[0]).not.toMatch(/&[a-z]*…/); // never cuts inside an entity
  });

  it("splits into labelled parts when the summary itself is too long (step 2)", () => {
    const report = sampleReport({
      analysis: analysis({
        summary: "S".repeat(1000),
        key_points: Array.from({ length: 10 }, (_, i) => `Point ${i} ${"k & <k> ".repeat(60)}`),
      }) as never,
      excerpt: "x".repeat(3000),
    });
    const parts = renderTelegram(report);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect(p.startsWith(`(${i + 1}/${parts.length})\n`)).toBe(true);
      assertWellFormed(p);
    });
    // Nothing is lost apart from the excerpt shortening.
    const all = parts.map(visible).join("\n");
    for (const point of report.analysis?.key_points ?? []) expect(all).toContain(point);
  });

  it("splits a single oversize line without breaking tags", () => {
    const parts = renderTelegram(
      sampleReport({ original: { ...sampleReport().original, subject: "T".repeat(9000) } }),
    );
    expect(parts.length).toBeGreaterThan(2);
    parts.forEach((p) => {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      assertWellFormed(p);
    });
  });
});
