import type { ProviderPreset } from "../config/providers.js";

// "Open original" links (002 research R7, FR-129). Built by code only, never by the AI.

const ALLOWED_HOSTS = new Set([
  "mail.google.com",
  "outlook.office365.com",
  "outlook.office.com",
  "outlook.live.com",
]);

/** Returns the URL if it is https on a known webmail host, else null. */
export function safeWebLink(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function webLinkFor(
  kind: ProviderPreset["webLink"],
  opts: { accountEmail: string; messageId: string | null; providerLink?: string | undefined },
): string | null {
  if (kind === "gmail-msgid") {
    if (!opts.messageId) return null;
    // Searching by Message-ID works for API and IMAP access and survives label changes;
    // `u/<email>` picks the right signed-in account.
    const id = opts.messageId.replace(/^<|>$/g, "");
    return safeWebLink(
      `https://mail.google.com/mail/u/${encodeURIComponent(opts.accountEmail)}/#search/rfc822msgid%3A${encodeURIComponent(id)}`,
    );
  }
  if (kind === "graph") return safeWebLink(opts.providerLink);
  return null;
}
