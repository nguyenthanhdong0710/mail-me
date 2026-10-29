import type { AccountConfig, AppConfig, EmailChannelConfig, GrantRef } from "../config/load.js";
import { GmailApiSender, GraphSender } from "../courier/channels/email/senders.js";
import type {
  GrantStore,
  HttpFetch,
  MailSender,
  MailSource,
  OAuthClient,
  OAuthProvider,
  TokenProvider,
} from "../domain/ports.js";
import { GmailApiSource } from "../fetcher/gmail-source.js";
import { GraphMailSource } from "../fetcher/graph-source.js";
import { ApiClient } from "../lib/api-client.js";
import { FileGrantStore } from "./grants.js";
import { GoogleOAuthClient } from "./google.js";
import { MicrosoftOAuthClient } from "./microsoft.js";
import { GrantTokenProvider } from "./tokens.js";

export interface OAuthWiring {
  grants: GrantStore;
  client(
    provider: OAuthProvider,
    opts?: { port?: number; listen?: string; loginHint?: string },
  ): OAuthClient;
  /** Read-only source for an OAuth account. */
  source(account: AccountConfig): MailSource;
  /** Send-only sender for `delivery.email.oauth`. */
  sender(oauth: NonNullable<EmailChannelConfig["oauth"]>): MailSender;
}

/** Builds the OAuth clients, token providers and API adapters for one process. */
export function createOAuthWiring(
  config: AppConfig,
  opts: { addSecret: (value: string) => void; fetch?: HttpFetch; grants?: GrantStore },
): OAuthWiring {
  const fetchFn: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const grants = opts.grants ?? new FileGrantStore(config.auth.grantsDir);
  const tokens = new Map<string, TokenProvider>();

  const client: OAuthWiring["client"] = (provider, o = {}) => {
    if (provider === "google") {
      if (!config.auth.google) throw new Error("auth.google is not configured");
      return new GoogleOAuthClient({
        clientId: config.auth.google.clientId,
        clientSecret: config.auth.google.clientSecret,
        port: o.port ?? 53682,
        listenHost: o.listen ?? "127.0.0.1",
        ...(o.loginHint && { loginHint: o.loginHint }),
        fetch: fetchFn,
      });
    }
    if (!config.auth.microsoft) throw new Error("auth.microsoft is not configured");
    return new MicrosoftOAuthClient({
      clientId: config.auth.microsoft.clientId,
      tenant: config.auth.microsoft.tenant,
      fetch: fetchFn,
    });
  };

  const tokensFor = (ref: GrantRef): TokenProvider => {
    let t = tokens.get(ref.name);
    if (!t) {
      t = new GrantTokenProvider(ref, grants, client(ref.provider), { addSecret: opts.addSecret });
      tokens.set(ref.name, t);
    }
    return t;
  };
  const api = (ref: GrantRef, label: string) => new ApiClient(fetchFn, tokensFor(ref), ref, label);

  return {
    grants,
    client,
    source(account) {
      if (!account.grant) throw new Error(`account ${account.id} does not use OAuth`);
      return account.grant.provider === "google"
        ? new GmailApiSource(api(account.grant, `gmail ${account.id}`))
        : new GraphMailSource(api(account.grant, `graph ${account.id}`));
    },
    sender(oauth) {
      const ref = oauth.grant;
      return oauth.provider === "gmail"
        ? new GmailApiSender(api(ref, "gmail send"), tokensFor(ref))
        : new GraphSender(api(ref, "graph send"), tokensFor(ref));
    },
  };
}
