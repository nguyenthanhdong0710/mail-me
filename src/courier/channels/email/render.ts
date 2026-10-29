import type { Report } from "../../../domain/types.js";
import { formatSender } from "../../report.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function emailSubject(report: Report): string {
  const subject = report.original.subject;
  if (report.kind === "FALLBACK") return `[Not summarized] ${subject}`;
  return `${report.urgent ? "🔴 " : ""}[AI Summary] ${subject}`;
}

const STYLE = {
  body: "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:680px",
  meta: "color:#57606a;font-size:13px;margin:0 0 12px",
  urgent: "background:#ffebe9;border-left:4px solid #cf222e;padding:8px 12px;margin:0 0 12px",
  warn: "background:#fff8c5;border-left:4px solid #bf8700;padding:8px 12px;margin:0 0 12px",
  h: "font-size:15px;margin:16px 0 4px",
  excerpt:
    "color:#57606a;border-left:3px solid #d0d7de;padding:4px 12px;white-space:pre-wrap;margin:0",
} as const;

/** HTML + plain-text report. Every interpolated value is escaped (FR-008). */
export function renderEmail(report: Report): RenderedEmail {
  const a = report.analysis;
  const e = escapeHtml;
  const sender = formatSender(report.original.from);
  const html: string[] = [`<div style="${STYLE.body}">`];
  const text: string[] = [];

  html.push(
    `<p style="${STYLE.meta}">📥 <b>${e(report.source.label)}</b> · From: ${e(sender)}<br>Subject: ${e(report.original.subject)}</p>`,
  );
  text.push(
    `Source: ${report.source.label}`,
    `From: ${sender}`,
    `Subject: ${report.original.subject}`,
    "",
  );

  if (!a) {
    html.push(
      `<p style="${STYLE.warn}">⚠️ <b>AI summary unavailable.</b> The original excerpt is below.</p>`,
    );
    text.push("⚠ AI summary unavailable. The original excerpt is below.", "");
  } else {
    if (report.urgent) {
      html.push(`<p style="${STYLE.urgent}">🔴 <b>Needs immediate attention</b></p>`);
      text.push("🔴 NEEDS IMMEDIATE ATTENTION", "");
    }
    html.push(`<p><b>TL;DR:</b> ${e(a.summary)}</p>`);
    text.push(`TL;DR: ${a.summary}`, "");

    if (a.key_points.length > 0) {
      html.push(`<p style="${STYLE.h}"><b>Key points</b></p><ul>`);
      html.push(...a.key_points.map((p) => `<li>${e(p)}</li>`), "</ul>");
      text.push("Key points:", ...a.key_points.map((p) => `- ${p}`), "");
    }
    if (a.action_items.length > 0) {
      html.push(`<p style="${STYLE.h}"><b>Action items</b></p><ul>`);
      for (const item of a.action_items) {
        const deadline = item.deadline ? ` — <i>${e(item.deadline)}</i>` : "";
        html.push(`<li>☐ ${e(item.action)}${deadline}</li>`);
        text.push(`[ ] ${item.action}${item.deadline ? ` — ${item.deadline}` : ""}`);
      }
      html.push("</ul>");
      text.push("");
    }
    html.push(`<p><b>Action needed:</b> ${report.actionNeeded ? "Yes" : "No"}</p>`);
    text.push(`Action needed: ${report.actionNeeded ? "Yes" : "No"}`, "");
  }

  if (report.truncated) {
    html.push(`<p style="${STYLE.meta}">(content truncated before processing)</p>`);
    text.push("(content truncated before processing)", "");
  }
  if (report.excerpt) {
    html.push(
      `<p style="${STYLE.h}">--- Original excerpt ---</p><p style="${STYLE.excerpt}">${e(report.excerpt)}</p>`,
    );
    text.push("--- Original excerpt ---", report.excerpt);
  }
  html.push("</div>");

  return { subject: emailSubject(report), html: html.join("\n"), text: text.join("\n") };
}
