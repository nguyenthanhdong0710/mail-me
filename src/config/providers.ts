import type { OAuthProvider } from "../domain/ports.js";

// Built-in mail provider presets (002 research R6, data-model.md "Mail Provider Preset").

export type AuthMethod = "oauth" | "password";

export interface ServerSettings {
  host: string;
  port: number;
  secure: boolean;
}

export interface ProviderPreset {
  /** First entry is the default. */
  authMethods: AuthMethod[];
  oauthProvider: OAuthProvider | null;
  /** Null for API-only providers. */
  imap: ServerSettings | null;
  smtp: ServerSettings | null;
  /** How the "Open original" link is built (research R7). */
  webLink: "gmail-msgid" | "graph" | null;
}

const imaps = (host: string): ServerSettings => ({ host, port: 993, secure: true });
const smtps = (host: string): ServerSettings => ({ host, port: 465, secure: true });

export const PROVIDERS = {
  gmail: {
    authMethods: ["oauth", "password"],
    oauthProvider: "google",
    imap: imaps("imap.gmail.com"),
    smtp: smtps("smtp.gmail.com"),
    webLink: "gmail-msgid",
  },
  // Microsoft turned off password (basic) sign-in for Outlook.com and Exchange Online.
  microsoft: {
    authMethods: ["oauth"],
    oauthProvider: "microsoft",
    imap: null,
    smtp: null,
    webLink: "graph",
  },
  yahoo: {
    authMethods: ["password"],
    oauthProvider: null,
    imap: imaps("imap.mail.yahoo.com"),
    smtp: smtps("smtp.mail.yahoo.com"),
    webLink: null,
  },
  icloud: {
    authMethods: ["password"],
    oauthProvider: null,
    imap: imaps("imap.mail.me.com"),
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    webLink: null,
  },
  fastmail: {
    authMethods: ["password"],
    oauthProvider: null,
    imap: imaps("imap.fastmail.com"),
    smtp: smtps("smtp.fastmail.com"),
    webLink: null,
  },
  zoho: {
    authMethods: ["password"],
    oauthProvider: null,
    imap: imaps("imap.zoho.com"),
    smtp: smtps("smtp.zoho.com"),
    webLink: null,
  },
  gmx: {
    authMethods: ["password"],
    oauthProvider: null,
    imap: imaps("imap.gmx.com"),
    smtp: smtps("mail.gmx.com"),
    webLink: null,
  },
  aol: {
    authMethods: ["password"],
    oauthProvider: null,
    imap: imaps("imap.aol.com"),
    smtp: smtps("smtp.aol.com"),
    webLink: null,
  },
  custom: {
    authMethods: ["password"],
    oauthProvider: null,
    imap: null,
    smtp: null,
    webLink: null,
  },
} as const satisfies Record<string, ProviderPreset>;

export type ProviderName = keyof typeof PROVIDERS;

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as [ProviderName, ...ProviderName[]];

export function preset(name: ProviderName): ProviderPreset {
  return PROVIDERS[name];
}
