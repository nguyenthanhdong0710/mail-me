import type { GrantPurpose, OAuthProvider } from "../domain/ports.js";

// Least-privilege scopes (FR-101, FR-102, FR-118, contracts/mail-access.contract.md).

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

/** Exactly what the sign-in asks for. */
export const REQUESTED_SCOPES: Record<OAuthProvider, Record<GrantPurpose, string[]>> = {
  google: { read: [GMAIL_READONLY], send: [GMAIL_SEND] },
  microsoft: {
    read: ["offline_access", "User.Read", "Mail.Read"],
    send: ["offline_access", "User.Read", "Mail.Send"],
  },
};

/** The one scope a grant must hold for its purpose. */
const REQUIRED: Record<OAuthProvider, Record<GrantPurpose, string>> = {
  google: { read: GMAIL_READONLY, send: GMAIL_SEND },
  microsoft: { read: "mail.read", send: "mail.send" },
};

/** Human wording for the permission, shown by `mail-me auth`. */
export const PERMISSION_TEXT: Record<OAuthProvider, Record<GrantPurpose, string>> = {
  google: {
    read: "Read your email (gmail.readonly). Mail-Me cannot send, change or delete mail.",
    send: "Send email on your behalf (gmail.send). Mail-Me cannot read, change or delete mail.",
  },
  microsoft: {
    read: "Read your mail (Mail.Read). Mail-Me cannot send, change or delete mail.",
    send: "Send mail as you (Mail.Send). Mail-Me cannot read, change or delete mail.",
  },
};

/** Microsoft may return Graph scopes with their resource prefix and in any case. */
function normalize(provider: OAuthProvider, scope: string): string {
  return provider === "microsoft"
    ? scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase()
    : scope;
}

function blocked(provider: OAuthProvider, purpose: GrantPurpose, scope: string): boolean {
  if (/calendar/i.test(scope)) return true;
  if (provider === "google") {
    if (scope === "https://mail.google.com/") return true;
    return (
      scope.startsWith("https://www.googleapis.com/auth/gmail.") &&
      scope !== REQUIRED.google[purpose]
    );
  }
  if (/^(imap|pop|smtp|ews)\./.test(scope)) return true;
  if (scope.startsWith("mail.")) return scope !== REQUIRED.microsoft[purpose];
  return false;
}

/**
 * Why a granted scope set is unacceptable, or null when it is fine: it must include the
 * purpose's scope and nothing that could change, send (for read) or read (for send) mail, or
 * touch calendars. Extra identity scopes (openid, profile, email) are allowed.
 */
export function scopeProblem(
  provider: OAuthProvider,
  purpose: GrantPurpose,
  granted: string[],
): string | null {
  const scopes = granted.map((s) => normalize(provider, s));
  const bad = scopes.filter((s) => blocked(provider, purpose, s));
  if (bad.length > 0) return `grant has permissions Mail-Me must not hold: ${bad.join(", ")}`;
  if (!scopes.includes(REQUIRED[provider][purpose])) {
    return purpose === "read" ? "read access was not granted" : "send access was not granted";
  }
  return null;
}
