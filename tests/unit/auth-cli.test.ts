import { describe, expect, it } from "vitest";
import { parseAuthArgs, runAuth, type AuthDeps } from "../../src/auth/cli.js";
import { SignInCancelledError } from "../../src/auth/errors.js";
import { parseConfig } from "../../src/config/load.js";
import type { Grant, OAuthClient, SignInIO } from "../../src/domain/ports.js";
import { rawConfig, testEnv } from "../fakes/config.js";
import { MemoryGrants, sampleGrant } from "../fakes/grants.js";

function config() {
  const raw = rawConfig() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test mutation
  raw.auth = {
    google: { client_id: "client-1.apps.googleusercontent.com", client_secret_env: "GCS" },
  };
  raw.accounts.push({ id: "gmail", email: "student@university.edu", provider: "gmail" });
  raw.accounts[0].email = "other@university.edu";
  raw.accounts[0].imap.user = "other@university.edu";
  return parseConfig(raw, { ...testEnv, GCS: "client-secret" });
}

function io(): SignInIO & { out: string[] } {
  const out: string[] = [];
  return { out, print: (l) => out.push(l), readLine: () => new Promise(() => {}) };
}

function deps(signIn: () => Promise<Grant>, store = new MemoryGrants()) {
  const terminal = io();
  const client: OAuthClient = {
    provider: "google",
    signIn,
    refresh: () => Promise.reject(new Error("unused")),
  };
  const d: AuthDeps & { store: MemoryGrants } = {
    config: config(),
    io: terminal,
    client: () => client,
    store,
  };
  return { d, out: terminal.out, store };
}

describe("parseAuthArgs", () => {
  it("reads the account, flags and options", () => {
    expect(
      parseAuthArgs(["school", "--config", "c.json", "--port", "9000", "--listen", "0.0.0.0"]),
    ).toEqual({
      accountId: "school",
      emailChannel: false,
      status: false,
      port: 9000,
      listen: "0.0.0.0",
    });
    expect(parseAuthArgs(["--email-channel"])).toMatchObject({
      accountId: null,
      emailChannel: true,
    });
  });
});

describe("mail-me auth (contracts/auth-cli.contract.md)", () => {
  const args = parseAuthArgs(["gmail"]);

  it("saves a matching read-only grant and says what was granted", async () => {
    const { d, out, store } = deps(async () => sampleGrant());
    expect(await runAuth(args, d)).toBe(0);
    expect(store.files.get("gmail.read")).toEqual(sampleGrant());
    expect(out[0]).toBe('Signing in "gmail" (student@university.edu) with Google.');
    expect(out[1]).toContain("Read your email (gmail.readonly)");
    expect(out.at(-1)).toBe(
      "✓ Signed in student@university.edu with read-only mail access. Saved to gmail.read",
    );
    expect(out.join("\n")).not.toContain("refresh-secret");
  });

  it("saves nothing when the user signed in as someone else", async () => {
    const { d, out, store } = deps(async () => sampleGrant({ address: "x@gmail.com" }));
    expect(await runAuth(args, d)).toBe(1);
    expect(store.files.size).toBe(0);
    expect(out.at(-1)).toBe(
      '✗ You signed in as x@gmail.com, but "gmail" is student@university.edu. Nothing was saved.',
    );
  });

  it("saves nothing when read access was unticked", async () => {
    const { d, out, store } = deps(async () => sampleGrant({ scopes: [] }));
    expect(await runAuth(args, d)).toBe(1);
    expect(store.files.size).toBe(0);
    expect(out.at(-1)).toContain(
      'Read access was not granted. Run the command again and allow "Read your email"',
    );
  });

  it("reports cancellation", async () => {
    const { d, out } = deps(async () => {
      throw new SignInCancelledError();
    });
    expect(await runAuth(args, d)).toBe(1);
    expect(out.at(-1)).toBe("✗ Sign-in was cancelled or timed out.");
  });

  it("refuses unknown and password accounts", async () => {
    const { d, out } = deps(async () => sampleGrant());
    expect(await runAuth(parseAuthArgs(["nope"]), d)).toBe(2);
    expect(out.at(-1)).toBe('✗ Account "nope" not found');
    expect(await runAuth(parseAuthArgs(["school"]), d)).toBe(2);
    expect(out.at(-1)).toBe(
      '✗ Account "school" uses a password; OAuth is only for gmail and microsoft accounts.',
    );
  });

  it("lists grant status", async () => {
    const { d, out, store } = deps(async () => sampleGrant());
    expect(await runAuth(parseAuthArgs(["--status"]), d)).toBe(1);
    expect(out.at(-1)).toContain("not signed in. Run: mail-me auth gmail");
    store.files.set("gmail.read", sampleGrant());
    out.length = 0;
    expect(await runAuth(parseAuthArgs(["--status"]), d)).toBe(0);
    expect(out[0]).toContain("student@university.edu\tread-only");
  });
});
