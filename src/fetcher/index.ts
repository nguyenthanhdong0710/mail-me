import type { AccountConfig } from "../config/load.js";
import type { MailSource, MailSourceFactory } from "../domain/ports.js";
import { ImapMailSource } from "./imap-source.js";

/** Builds the read-only source for an OAuth account (Gmail API or Graph). */
export type OAuthSourceBuilder = (account: AccountConfig) => MailSource;

/**
 * Picks the adapter per account (contracts/mail-access.contract.md): IMAP for password
 * accounts, the provider's API for OAuth accounts.
 */
export function mailSourceFactory(
  accounts: AccountConfig[],
  oauthSource?: OAuthSourceBuilder,
): MailSourceFactory {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return (accountId) => {
    const account = byId.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    if (account.auth === "password") return new ImapMailSource(account);
    if (!oauthSource) throw new Error(`no OAuth mail source for account ${accountId}`);
    return oauthSource(account);
  };
}
