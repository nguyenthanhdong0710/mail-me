import nodemailer, { type Transporter } from "nodemailer";
import type { EmailChannelConfig } from "../../../config/load.js";
import {
  ChannelError,
  GrantRevokedError,
  type MailSender,
  type TokenProvider,
} from "../../../domain/ports.js";
import { ApiError, type ApiClient } from "../../../lib/api-client.js";

/** SMTP errors: auth failures and permanent (5xx) rejections are not worth retrying. */
export function classifySmtpError(err: unknown): ChannelError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const permanent = e.code === "EAUTH" || (e.responseCode !== undefined && e.responseCode >= 500);
  return new ChannelError(`smtp: ${e.message ?? String(err)}`, !permanent);
}

/** Password-based sending over SMTP with TLS (001 behavior). */
export class SmtpSender implements MailSender {
  private readonly transporter: Transporter;

  constructor(smtp: NonNullable<EmailChannelConfig["smtp"]>, transporter?: Transporter) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        requireTLS: !smtp.secure,
        auth: { user: smtp.user, pass: smtp.password },
      });
  }

  async send(
    mime: Buffer,
    envelope: { from: string; to: string },
  ): Promise<{ externalId: string }> {
    try {
      const info = await this.transporter.sendMail({
        envelope: { from: envelope.from, to: envelope.to },
        raw: mime,
      });
      return { externalId: info.messageId ? String(info.messageId) : "" };
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

/** Maps API failures to channel errors; a revoked grant is retried after the user signs in again. */
function apiChannelError(err: unknown, label: string): ChannelError {
  if (err instanceof ChannelError) return err;
  if (err instanceof GrantRevokedError) {
    return new ChannelError(
      `${label}: sending sign-in revoked or expired, run \`${err.fixCommand}\``,
      true,
    );
  }
  if (err instanceof ApiError)
    return new ChannelError(err.message, err.transient, err.retryAfterMs);
  return new ChannelError(`${label}: ${(err as Error).message}`, true);
}

/** Send-only Gmail API sender (`gmail.send`, research R4). */
export class GmailApiSender implements MailSender {
  constructor(
    private readonly api: ApiClient,
    private readonly tokens: TokenProvider,
  ) {}

  async send(mime: Buffer): Promise<{ externalId: string }> {
    try {
      const res = await this.api.json<{ id?: string }>(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw: mime.toString("base64url") }),
        },
      );
      return { externalId: res.id ?? "" };
    } catch (err) {
      throw apiChannelError(err, "gmail");
    }
  }

  async verify(): Promise<void> {
    try {
      await this.tokens.accessToken();
    } catch (err) {
      throw apiChannelError(err, "gmail");
    }
  }
}

/** Send-only Microsoft Graph sender (`Mail.Send`): `/me/sendMail` with a MIME body. */
export class GraphSender implements MailSender {
  constructor(
    private readonly api: ApiClient,
    private readonly tokens: TokenProvider,
  ) {}

  async send(mime: Buffer, envelope: { messageId?: string }): Promise<{ externalId: string }> {
    try {
      // 202 Accepted with no body: our own Message-ID identifies the report.
      await this.api.request("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: mime.toString("base64"),
      });
      return { externalId: envelope.messageId ?? "" };
    } catch (err) {
      throw apiChannelError(err, "graph");
    }
  }

  async verify(): Promise<void> {
    try {
      await this.tokens.accessToken();
    } catch (err) {
      throw apiChannelError(err, "graph");
    }
  }
}
