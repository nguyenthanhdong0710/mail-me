import { eventHeadline, SCHEDULER_FAILED_TEXT } from "../../../calendar/display.js";
import { safeWebLink } from "../../../fetcher/web-link.js";
import type { Report } from "../../../domain/types.js";
import { formatSender, recipientLine } from "../../report.js";

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
  event: "margin:8px 0;padding:8px 12px;background:#f6f8fa;border-radius:6px",
  excerpt:
    "color:#57606a;border-left:3px solid #d0d7de;padding:4px 12px;white-space:pre-wrap;margin:0",
} as const;

/** A link whose URL was built or validated by code (calendar links, original, meeting). */
function link(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** HTML + plain-text report. Every interpolated value is escaped (FR-008, FR-120, FR-128). */
export function renderEmail(report: Report): RenderedEmail {
  const a = report.analysis;
  const e = escapeHtml;
  const brief = report.style === "brief";
  const sender = formatSender(report.original.from);
  const recipients = recipientLine(report.original);
  const html: string[] = [`<div style="${STYLE.body}">`];
  const text: string[] = [];

  html.push(
    `<p style="${STYLE.meta}">📥 <b>${e(report.source.label)}</b> · From: ${e(sender)}<br>` +
      (recipients ? `👥 ${e(recipients)}<br>` : "") +
      `Subject: ${e(report.original.subject)}</p>`,
  );
  text.push(
    `Source: ${report.source.label}`,
    `From: ${sender}`,
    ...(recipients ? [`Recipients: ${recipients}`] : []),
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
      if (!brief) html.push(`<p style="${STYLE.h}"><b>Key points</b></p>`);
      html.push("<ul>", ...a.key_points.map((p) => `<li>${e(p)}</li>`), "</ul>");
      text.push(...(brief ? [] : ["Key points:"]), ...a.key_points.map((p) => `- ${p}`), "");
    }
    if (a.action_items.length > 0) {
      html.push(`<p style="${STYLE.h}"><b>${brief ? "✅ Actions" : "Action items"}</b></p><ul>`);
      text.push(brief ? "Actions:" : "Action items:");
      for (const item of a.action_items) {
        const deadline = item.deadline ? ` — <i>${e(item.deadline)}</i>` : "";
        html.push(`<li>☐ ${e(item.action)}${deadline}</li>`);
        text.push(`[ ] ${item.action}${item.deadline ? ` — ${item.deadline}` : ""}`);
      }
      html.push("</ul>");
      text.push("");
    }
    // Brief reports list actions only when there are any (FR-112); detailed keeps the 001 line.
    if (!brief || !report.actionNeeded) {
      html.push(`<p><b>Action needed:</b> ${report.actionNeeded ? "Yes" : "No"}</p>`);
      text.push(`Action needed: ${report.actionNeeded ? "Yes" : "No"}`, "");
    }
  }

  renderEvents(report, html, text);

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
  const original = safeWebLink(report.original.webLink);
  if (original) {
    html.push(`<p>${link(original, "Open original")}</p>`);
    text.push("", `Open original: ${original}`);
  }
  html.push("</div>");

  return { subject: emailSubject(report), html: html.join("\n"), text: text.join("\n") };
}

function renderEvents(report: Report, html: string[], text: string[]): void {
  const e = escapeHtml;
  const zone = report.timezone ?? "UTC";
  if (report.schedulerFailed) {
    html.push(`<p style="${STYLE.warn}">${e(SCHEDULER_FAILED_TEXT)}</p>`);
    text.push(SCHEDULER_FAILED_TEXT, "");
  }
  for (const ev of report.events ?? []) {
    const head = eventHeadline(ev, zone);
    const parts = [`📅 <b>${e(head)}</b>`];
    text.push(`📅 ${head}`);
    const details: string[] = [];
    if (ev.meetingUrl) {
      details.push(`Join: ${link(ev.meetingUrl, ev.meetingUrl)}`);
      text.push(`   Join: ${ev.meetingUrl}`);
    }
    if (ev.location) {
      details.push(`📍 ${e(ev.location)}`);
      text.push(`   📍 ${ev.location}`);
    }
    if (details.length) parts.push(details.join(" · "));
    if (ev.links) {
      parts.push(
        `${link(ev.links.google, "Add to Google Calendar")} · ${link(ev.links.outlook, "Add to Outlook calendar")}`,
      );
      text.push(
        `   Add to Google Calendar: ${ev.links.google}`,
        `   Add to Outlook calendar: ${ev.links.outlook}`,
      );
    }
    html.push(`<p style="${STYLE.event}">${parts.join("<br>")}</p>`);
  }
  if (report.eventsOmitted) {
    const more = `(+${report.eventsOmitted} more events in the email)`;
    html.push(`<p style="${STYLE.meta}">${e(more)}</p>`);
    text.push(more);
  }
  if (report.events?.length || report.eventsOmitted) text.push("");
}
