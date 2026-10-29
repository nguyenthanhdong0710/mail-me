import { describe, expect, it } from "vitest";
import { GrantRevokedError, type TokenProvider } from "../../src/domain/ports.js";
import { ApiClient, ApiError } from "../../src/lib/api-client.js";
import { FakeApi } from "../fakes/http.js";

function tokens(): TokenProvider & { invalidated: number } {
  let n = 0;
  const t = {
    invalidated: 0,
    accessToken: async () => `token-${n + 1}`,
    invalidate: () => {
      t.invalidated++;
      n++;
    },
  };
  return t;
}

const revoked = { name: "school.read", fixCommand: "mail-me auth school" };

describe("ApiClient", () => {
  it("sends the bearer token", async () => {
    const api = new FakeApi().on("GET", /example\.test\/x/, { json: { ok: 1 } });
    const client = new ApiClient(api.fetch, tokens(), revoked, "gmail");
    expect(await client.json("https://example.test/x")).toEqual({ ok: 1 });
    expect(api.calls[0]!.headers.authorization).toBe("Bearer token-1");
  });

  it("refreshes once after a 401, then reports the grant as revoked", async () => {
    const t = tokens();
    const api = new FakeApi()
      .once("GET", /example\.test\/x/, { status: 401, json: {} })
      .on("GET", /example\.test\/x/, { json: { ok: 1 } });
    await new ApiClient(api.fetch, t, revoked, "gmail").json("https://example.test/x");
    expect(t.invalidated).toBe(1);
    expect(api.calls.map((c) => c.headers.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);

    const always401 = new FakeApi().on("GET", /example\.test\/x/, { status: 401, json: {} });
    await expect(
      new ApiClient(always401.fetch, tokens(), revoked, "gmail").json("https://example.test/x"),
    ).rejects.toBeInstanceOf(GrantRevokedError);
  });

  it("marks 429 and 5xx as transient with Retry-After", async () => {
    const api = new FakeApi().on("GET", /example\.test\/x/, {
      status: 429,
      json: { error: { code: 429, message: "slow down" } },
      headers: { "retry-after": "7" },
    });
    const err = (await new ApiClient(api.fetch, tokens(), revoked, "graph")
      .json("https://example.test/x")
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.transient).toBe(true);
    expect(err.retryAfterMs).toBe(7000);
    expect(err.message).toContain("graph: HTTP 429");
    expect(err.message).not.toContain("token-");
  });
});
