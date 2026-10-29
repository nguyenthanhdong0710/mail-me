import { describe, expect, it } from "vitest";
import { InvalidGrantError, TokenEndpointError } from "../../src/auth/token-endpoint.js";
import { GrantTokenProvider } from "../../src/auth/tokens.js";
import {
  GrantRevokedError,
  type Grant,
  type GrantStore,
  type OAuthClient,
} from "../../src/domain/ports.js";
import { FakeClock } from "../fakes/index.js";
import { sampleGrant } from "../fakes/grants.js";

class MemoryGrants implements GrantStore {
  readonly files = new Map<string, Grant>();
  writes = 0;
  read(name: string) {
    return this.files.get(name) ?? null;
  }
  write(name: string, grant: Grant) {
    this.writes++;
    this.files.set(name, grant);
  }
}

function client(refresh: OAuthClient["refresh"]): OAuthClient & { calls: number } {
  const c = {
    provider: "google" as const,
    calls: 0,
    signIn: () => Promise.reject(new Error("unused")),
    refresh: (g: Grant) => {
      c.calls++;
      return refresh(g);
    },
  };
  return c;
}

const ref = { name: "school.read", fixCommand: "mail-me auth school" };

describe("GrantTokenProvider (FR-104, research R5)", () => {
  it("caches the access token until a minute before it expires", async () => {
    const clock = new FakeClock(new Date("2026-10-30T00:00:00Z"));
    const store = new MemoryGrants();
    store.files.set("school.read", sampleGrant());
    let n = 0;
    const c = client(async () => ({
      accessToken: `ya29.token-${++n}`,
      expiresAt: new Date(clock.now().getTime() + 3600_000),
    }));
    const tokens = new GrantTokenProvider(ref, store, c, { clock });
    expect(await tokens.accessToken()).toBe("ya29.token-1");
    clock.advance(3540_000 - 1);
    expect(await tokens.accessToken()).toBe("ya29.token-1");
    clock.advance(2);
    expect(await tokens.accessToken()).toBe("ya29.token-2");
    tokens.invalidate();
    expect(await tokens.accessToken()).toBe("ya29.token-3");
  });

  it("shares one refresh between concurrent callers", async () => {
    const store = new MemoryGrants();
    store.files.set("school.read", sampleGrant());
    const c = client(async () => ({
      accessToken: "ya29.x",
      expiresAt: new Date(Date.now() + 3600_000),
    }));
    const tokens = new GrantTokenProvider(ref, store, c);
    await Promise.all([tokens.accessToken(), tokens.accessToken(), tokens.accessToken()]);
    expect(c.calls).toBe(1);
  });

  it("saves a rotated refresh token and registers every token as a secret", async () => {
    const store = new MemoryGrants();
    store.files.set("school.read", sampleGrant());
    const secrets: string[] = [];
    const c = client(async () => ({
      accessToken: "ya29.access",
      refreshToken: "1//rotated",
      expiresAt: new Date(Date.now() + 3600_000),
    }));
    await new GrantTokenProvider(ref, store, c, {
      addSecret: (s) => secrets.push(s),
    }).accessToken();
    expect(store.files.get("school.read")!.refreshToken).toBe("1//rotated");
    expect(secrets).toEqual(["1//refresh-secret", "ya29.access", "1//rotated"]);
  });

  it("turns a dead grant into GrantRevokedError with the fix command", async () => {
    const store = new MemoryGrants();
    store.files.set("school.read", sampleGrant());
    const c = client(async () => {
      throw new InvalidGrantError("invalid_grant: Token has been expired or revoked.");
    });
    const err = await new GrantTokenProvider(ref, store, c).accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(GrantRevokedError);
    expect((err as GrantRevokedError).fixCommand).toBe("mail-me auth school");
    expect((err as Error).message).toContain("run: mail-me auth school");
  });

  it("treats a missing grant file as revoked and token-endpoint outages as transient", async () => {
    const store = new MemoryGrants();
    const ok = client(async () => ({ accessToken: "a", expiresAt: new Date() }));
    await expect(new GrantTokenProvider(ref, store, ok).accessToken()).rejects.toBeInstanceOf(
      GrantRevokedError,
    );
    store.files.set("school.read", sampleGrant());
    const down = client(async () => {
      throw new TokenEndpointError("HTTP 503");
    });
    await expect(new GrantTokenProvider(ref, store, down).accessToken()).rejects.toBeInstanceOf(
      TokenEndpointError,
    );
  });
});
