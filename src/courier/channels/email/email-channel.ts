import nodemailer, { type Transporter } from "nodemailer";
import type { EmailChannelConfig } from "../../../config/load.js";
import { ChannelError, type ReportChannel } from "../../../domain/ports.js";
import type { Report } from "../../../domain/types.js";
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

/** SMTP errors: auth failures and permanent (5xx) rejections are not worth retrying. */
export function classifySmtpError(err: unknown): ChannelError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const permanent = e.code === "EAUTH" || (e.responseCode !== undefined && e.responseCode >= 500);
  return new ChannelError(`smtp: ${e.message ?? String(err)}`, !permanent);
}

export class EmailChannel implements ReportChannel {
  readonly name = "email" as const;
  private readonly transporter: Transporter;

  constructor(
    private readonly cfg: EmailChannelConfig,
    private readonly installId: string,
    transporter?: Transporter,
  ) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        requireTLS: !cfg.smtp.secure,
        auth: { user: cfg.smtp.user, pass: cfg.smtp.password },
      });
  }

  async deliver(report: Report): Promise<{ externalId: string }> {
    const rendered = renderEmail(report);
    try {
      const info = await this.transporter.sendMail({
        from: this.cfg.from,
        to: this.cfg.to,
        replyTo: formatSender(report.original.from),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: reportHeaders(report, this.installId),
      });
      return { externalId: String(info.messageId) };
    } catch (err) {
      throw classifySmtpError(err);
    }
  }

  async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (err) {
      throw classifySmtpError(err);
    }
  }
}
