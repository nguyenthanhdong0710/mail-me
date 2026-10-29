import { describe, expect, it } from "vitest";
import { checkGrants, ConfigError, parseConfig } from "../../src/config/load.js";
import { rawConfig, testEnv } from "../fakes/config.js";
import { MemoryGrants, sampleGrant } from "../fakes/grants.js";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form test mutation

const env = {
  ...testEnv,
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  YAHOO_PW: "yahoo-pw",
};
const googleApp = {
  client_id: "client-1.apps.googleusercontent.com",
  client_secret_env: "GOOGLE_OAUTH_CLIENT_SECRET",
};

function parse(mutate: (raw: Raw) => void) {
  const raw = rawConfig() as Raw;
  mutate(raw);
  return parseConfig(raw, env);
}

function errorOf(mutate: (raw: Raw) => void): string {
  try {
    parse(mutate);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a ConfigError");
}

const gmailOAuth = (c: Raw) => {
  c.auth = { google: googleApp };
  c.accounts[0] = { id: "school", email: "student@university.edu", provider: "gmail" };
};

describe("accounts: providers and sign-in methods (FR-106–108)", () => {
  it("still accepts a feature-001 config unchanged", () => {
    const cfg = parse(() => {});
    expect(cfg.accounts[0]).toMatchObject({
      provider: "custom",
      auth: "password",
      grant: null,
      imap: { host: "imap.example.com", port: 993, secure: true, user: "student@university.edu" },
    });
  });

  it("fills server settings from a preset and lets explicit settings win", () => {
    const cfg = parse((c) => {
      c.accounts.push(
        {
          id: "yahoo",
          email: "me@yahoo.com",
          provider: "yahoo",
          imap: { password_env: "YAHOO_PW" },
        },
        {
          id: "zoho-eu",
          email: "me@zoho.eu",
          provider: "zoho",
          imap: { host: "imap.zoho.eu", password_env: "YAHOO_PW" },
        },
      );
    });
    expect(cfg.accounts[1]!.imap).toEqual({
      host: "imap.mail.yahoo.com",
      port: 993,
      secure: true,
      user: "me@yahoo.com",
      password: "yahoo-pw",
    });
    expect(cfg.accounts[2]!.imap!.host).toBe("imap.zoho.eu");
  });

  it("makes gmail default to OAuth with a read grant and no password", () => {
    const cfg = parse(gmailOAuth);
    expect(cfg.accounts[0]).toMatchObject({
      provider: "gmail",
      auth: "oauth",
      imap: null,
      webLink: "gmail-msgid",
      grant: {
        name: "school.read",
        provider: "google",
        purpose: "read",
        fixCommand: "mail-me auth school",
      },
    });
    expect(cfg.auth.google).toEqual({
      clientId: googleApp.client_id,
      clientSecret: "google-client-secret",
    });
    expect(cfg.secrets).toContain("google-client-secret");
  });

  it("rejects a custom server without a host", () => {
    expect(
      errorOf((c) => {
        delete c.accounts[0].imap.host;
      }),
    ).toContain("accounts[0].imap.host — required unless");
  });

  it("rejects Microsoft with a password", () => {
    expect(
      errorOf((c) => {
        c.accounts[0] = {
          id: "work",
          email: "me@company.com",
          provider: "microsoft",
          auth: "password",
          imap: { password_env: "YAHOO_PW" },
        };
      }),
    ).toContain("accounts[0].auth — Microsoft turned off password sign-in");
  });

  it("rejects an imap block on an OAuth account and OAuth on a password-only provider", () => {
    expect(
      errorOf((c) => {
        gmailOAuth(c);
        c.accounts[0].imap = { password_env: "YAHOO_PW" };
      }),
    ).toContain("accounts[0].imap — only for password accounts");
    expect(
      errorOf((c) => {
        c.accounts[0] = { id: "y", email: "me@yahoo.com", provider: "yahoo", auth: "oauth" };
      }),
    ).toContain('provider "yahoo" supports "password", not "oauth"');
  });

  it("requires the OAuth app block for the provider in use", () => {
    expect(
      errorOf((c) => {
        gmailOAuth(c);
        delete c.auth;
      }),
    ).toContain('auth.google — required because accounts[0] ("school") uses OAuth with gmail');
  });
});

describe("email channel sending account", () => {
  it("fills SMTP settings from a preset", () => {
    const cfg = parse((c) => {
      c.delivery.email.smtp = {
        provider: "icloud",
        user: "me@icloud.com",
        password_env: "YAHOO_PW",
      };
    });
    expect(cfg.delivery.email!.smtp).toMatchObject({
      host: "smtp.mail.me.com",
      port: 587,
      secure: false,
    });
  });

  it("uses a send-only grant for OAuth sending", () => {
    const cfg = parse((c) => {
      c.auth = { google: googleApp };
      delete c.delivery.email.smtp;
      c.delivery.email.oauth = { provider: "gmail", user: "me@gmail.com" };
    });
    expect(cfg.delivery.email).toMatchObject({
      smtp: null,
      from: "me@gmail.com",
      oauth: {
        grant: {
          name: "email-channel.send",
          purpose: "send",
          fixCommand: "mail-me auth --email-channel",
        },
      },
    });
  });
});

describe("grant startup checks (FR-108)", () => {
  const config = () => parse(gmailOAuth);

  it("passes with a matching read grant", () => {
    const store = new MemoryGrants();
    store.files.set("school.read", sampleGrant());
    expect(() => checkGrants(config(), store)).not.toThrow();
  });

  it("allows identity scopes the provider adds", () => {
    const store = new MemoryGrants();
    store.files.set(
      "school.read",
      sampleGrant({ scopes: [...sampleGrant().scopes, "openid", "email"] }),
    );
    expect(() => checkGrants(config(), store)).not.toThrow();
  });

  it.each([
    ["no grant", undefined, 'accounts[0] ("school"): not signed in. Run: mail-me auth school'],
    [
      "another address",
      sampleGrant({ address: "other@gmail.com" }),
      "signed in as other@gmail.com, but the config says student@university.edu",
    ],
    [
      "another OAuth app",
      sampleGrant({ clientId: "someone-else" }),
      "the grant was issued to a different OAuth app",
    ],
    [
      "full mail access",
      sampleGrant({ scopes: ["https://mail.google.com/"] }),
      "grant has permissions Mail-Me must not hold: https://mail.google.com/",
    ],
    [
      "send instead of read",
      sampleGrant({ purpose: "send" }),
      "the grant file is for google/send, not google/read",
    ],
    [
      "a calendar scope",
      sampleGrant({
        scopes: [...sampleGrant().scopes, "https://www.googleapis.com/auth/calendar"],
      }),
      "must not hold",
    ],
  ])("fails with %s", (_name, grant, message) => {
    const store = new MemoryGrants();
    if (grant) store.files.set("school.read", grant);
    expect(() => checkGrants(config(), store)).toThrow(ConfigError);
    expect(() => checkGrants(config(), store)).toThrow(message);
  });
});
