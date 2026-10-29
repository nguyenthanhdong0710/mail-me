import { describe, expect, it } from "vitest";
import { AdminConsentRequiredError, SignInCancelledError } from "../../src/auth/errors.js";
import { MicrosoftOAuthClient } from "../../src/auth/microsoft.js";
import { InvalidGrantError } from "../../src/auth/token-endpoint.js";
import type { SignInIO } from "../../src/domain/ports.js";
import { sampleGrant } from "../fakes/grants.js";
import { FakeApi, type RouteReply } from "../fakes/http.js";

const DEVICE = /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/devicecode$/;
const TOKEN = /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/;

function msApi(tokenReplies: RouteReply[]) {
  const api = new FakeApi()
    .on("POST", DEVICE, {
      json: {
        device_code: "dev-123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
      },
    })
    .on("GET", /graph\.microsoft\.com\/v1\.0\/me$/, {
      json: { mail: null, userPrincipalName: "me@company.com" },
    });
  for (const r of tokenReplies) api.once("POST", TOKEN, r);
  return api;
}

const io = (): SignInIO & { out: string[] } => {
  const out: string[] = [];
  return { out, print: (l) => out.push(l), readLine: () => new Promise(() => {}) };
};

function client(api: FakeApi, sleeps: number[] = []) {
  return new MicrosoftOAuthClient({
    clientId: "app-id",
    tenant: "common",
    fetch: api.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

const success = {
  json: {
    access_token: "eyJ.access",
    refresh_token: "0.refresh",
    scope: "Mail.Read User.Read profile openid email",
    expires_in: 3600,
  },
};

describe("MicrosoftOAuthClient (device code, research R3)", () => {
  it("asks for exactly the read scopes and confirms the account", async () => {
    const sleeps: number[] = [];
    const api = msApi([
      { status: 400, json: { error: "authorization_pending" } },
      { status: 400, json: { error: "slow_down" } },
      success,
    ]);
    const terminal = io();
    const grant = await client(api, sleeps).signIn("read", terminal);
    expect(new URLSearchParams(api.callsTo(DEVICE)[0]!.body).get("scope")).toBe(
      "offline_access User.Read Mail.Read",
    );
    expect(terminal.out[0]).toBe(
      "On any device, open https://microsoft.com/devicelogin and enter the code: ABCD-EFGH",
    );
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(grant).toMatchObject({
      provider: "microsoft",
      purpose: "read",
      address: "me@company.com",
      tenant: "common",
      refreshToken: "0.refresh",
      scopes: ["Mail.Read", "User.Read", "profile", "openid", "email"],
    });
  });

  it("asks for Mail.Send for the email channel", async () => {
    const api = msApi([success]);
    await client(api).signIn("send", io());
    expect(new URLSearchParams(api.callsTo(DEVICE)[0]!.body).get("scope")).toBe(
      "offline_access User.Read Mail.Send",
    );
  });

  it("explains when an administrator must approve the app (US2-2)", async () => {
    const api = msApi([
      {
        status: 400,
        json: {
          error: "invalid_grant",
          error_description:
            "AADSTS65001: The user or administrator has not consented to use the application.",
        },
      },
    ]);
    const err = (await client(api)
      .signIn("read", io())
      .catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(AdminConsentRequiredError);
    expect(err.message).toContain("administrator to approve this app");
    expect(err.message).toContain("app-id");
  });

  it("reports a declined or expired code as cancelled", async () => {
    const api = msApi([{ status: 400, json: { error: "authorization_declined" } }]);
    await expect(client(api).signIn("read", io())).rejects.toBeInstanceOf(SignInCancelledError);
  });

  it("returns the rotated refresh token and detects a revoked grant", async () => {
    const api = new FakeApi()
      .once("POST", TOKEN, {
        json: { access_token: "eyJ.new", refresh_token: "0.rotated", expires_in: 3600 },
      })
      .on("POST", TOKEN, {
        status: 400,
        json: {
          error: "invalid_grant",
          error_description: "AADSTS70008: The refresh token has expired.",
        },
      });
    const grant = sampleGrant({ provider: "microsoft", refreshToken: "0.old" });
    expect(await client(api).refresh(grant)).toMatchObject({
      accessToken: "eyJ.new",
      refreshToken: "0.rotated",
    });
    expect(new URLSearchParams(api.calls[0]!.body).get("scope")).toBe(
      "offline_access User.Read Mail.Read",
    );
    await expect(client(api).refresh(grant)).rejects.toBeInstanceOf(InvalidGrantError);
  });
});
