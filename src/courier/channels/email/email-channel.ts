import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ReportChannel, MailSender } from "../../../domain/ports.js";
import type { Report } from "../../../domain/types.js";
import { icsFile } from "../../../calendar/ics.js";
import { eventDetails } from "../../../calendar/links.js";
import { formatSender } from "../../report.js";
import { renderEmail } from "./render.js";

export const SELF_SENT_HEADER = "X-Mail-Me";

export function selfSentMarker(installId: string): string {
  return `report; v=1; id=${installId}`;
}

/** Headers that mark a report as ours (FR-022) and thread it with the original. */
export function reportHeaders(report: Report, installId: string): Record<string, string> {
  const headers: Record<string, string> = {
    [SELF_SENT_HEADER]: selfSentMarker(installId),
    "Auto-Submitted": "auto-generated",
    "X-Mail-Me-Source": report.source.label,
  };
  if (report.original.messageId) {
    headers["In-Reply-To"] = report.original.messageId;
    headers["References"] = report.original.messageId;
  }
  return headers;
}

/** `Name <a@b>` → `a@b`, for SMTP envelopes and API senders. */
export function bareAddress(value: string): string {
  const m = /<([^>]+)>\s*$/.exec(value);
  return (m ? m[1]! : value).trim();
}

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

/** `event.ics` for the events that got calendar links (FR-117, research R11). */
export function eventAttachment(report: Report, now: Date): EmailAttachment | null {
  const events = (report.events ?? []).filter((e) => e.links);
  if (events.length === 0) return null;
  const from = formatSender(report.original.from);
  return {
    filename: "event.ics",
    content: icsFile(events, report.key, now, (e) =>
      eventDetails(e, from, report.original.subject),
    ),
    contentType: "text/calendar; method=PUBLISH; charset=utf-8",
  };
}

/**
 * Builds the complete MIME message once, so every sender (SMTP, Gmail API, Graph) delivers
 * identical headers and attachments (002 research R4).
 */
export async function buildMime(
  report: Report,
  cfg: { from: string; to: string },
  installId: string,
  now: Date = new Date(),
): Promise<{ mime: Buffer; messageId: string }> {
  const rendered = renderEmail(report);
  const ics = eventAttachment(report, now);
  const node = new MailComposer({
    from: cfg.from,
    to: cfg.to,
    replyTo: formatSender(report.original.from),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: reportHeaders(report, installId),
    attachments: ics ? [ics] : [],
  }).compile();
  return { mime: await node.build(), messageId: node.messageId() };
}

export class EmailChannel implements ReportChannel {
  readonly name = "email" as const;

  constructor(
    private readonly cfg: { from: string; to: string },
    private readonly installId: string,
    private readonly sender: MailSender,
  ) {}

  async deliver(report: Report): Promise<{ externalId: string }> {
    const { mime, messageId } = await buildMime(report, this.cfg, this.installId);
    const { externalId } = await this.sender.send(mime, {
      from: bareAddress(this.cfg.from),
      to: bareAddress(this.cfg.to),
      messageId,
    });
    return { externalId: externalId || messageId };
  }

  verify(): Promise<void> {
    return this.sender.verify();
  }
}
