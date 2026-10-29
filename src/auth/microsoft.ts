import type { Grant, GrantPurpose, HttpFetch, OAuthClient, SignInIO } from "../domain/ports.js";
import { AdminConsentRequiredError, SignInCancelledError } from "./errors.js";
import { REQUESTED_SCOPES } from "./scopes.js";
import { postForm, refreshError, splitScopes, type TokenResponse } from "./token-endpoint.js";

const ADMIN_CONSENT = /AADSTS(65001|90094|90099)\b/;

export interface MicrosoftOAuthOptions {
  clientId: string;
  tenant: string;
  fetch?: HttpFetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Microsoft identity platform, public client, device code flow (002 research R3): made for
 * headless machines, the user enters a short code on any device.
 */
export class MicrosoftOAuthClient implements OAuthClient {
  readonly provider = "microsoft" as const;
  private readonly fetch: HttpFetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: MicrosoftOAuthOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private endpoint(name: "devicecode" | "token"): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.opts.tenant)}/oauth2/v2.0/${name}`;
  }

  async signIn(purpose: GrantPurpose, io: SignInIO): Promise<Grant> {
    const scope = REQUESTED_SCOPES.microsoft[purpose].join(" ");
    const start = await postForm(this.fetch, this.endpoint("devicecode"), {
      client_id: this.opts.clientId,
      scope,
    });
    this.throwIfAdminConsent(start.body);
    const device = start.body as TokenResponse & {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
    };
    if (start.status !== 200 || !device.device_code || !device.user_code) {
      throw new Error(
        `Microsoft sign-in could not start: ${device.error_description ?? device.error ?? `HTTP ${start.status}`}`,
      );
    }

    const minutes = Math.round((device.expires_in ?? 900) / 60);
    io.print(
      `On any device, open ${device.verification_uri ?? "https://microsoft.com/devicelogin"} and enter the code: ${device.user_code}`,
    );
    io.print(`Waiting … (expires in ${minutes} minutes)`);

    const deadline = Date.now() + (device.expires_in ?? 900) * 1000;
    let interval = (device.interval ?? 5) * 1000;
    for (;;) {
      await this.sleep(interval);
      if (Date.now() > deadline) throw new SignInCancelledError("the code expired");
      const { status, body } = await postForm(this.fetch, this.endpoint("token"), {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: this.opts.clientId,
        device_code: device.device_code,
      });
      if (status === 200 && body.access_token && body.refresh_token) {
        return this.grant(purpose, body.access_token, body.refresh_token, splitScopes(body.scope));
      }
      this.throwIfAdminConsent(body);
      switch (body.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval += 5000;
          continue;
        case "authorization_declined":
        case "access_denied":
        case "expired_token":
          throw new SignInCancelledError(body.error);
        default:
          throw new Error(
            `Microsoft sign-in failed: ${body.error_description?.split("\n")[0] ?? body.error ?? `HTTP ${status}`}`,
          );
      }
    }
  }

  async refresh(
    grant: Grant,
  ): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }> {
    const { status, body } = await postForm(this.fetch, this.endpoint("token"), {
      grant_type: "refresh_token",
      client_id: this.opts.clientId,
      refresh_token: grant.refreshToken,
      scope: REQUESTED_SCOPES.microsoft[grant.purpose].join(" "),
    });
    if (status !== 200 || !body.access_token) throw refreshError(status, body);
    return {
      accessToken: body.access_token,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
      // Microsoft rotates refresh tokens; the token provider saves the new one.
      ...(body.refresh_token && { refreshToken: body.refresh_token }),
    };
  }

  private async grant(
    purpose: GrantPurpose,
    accessToken: string,
    refreshToken: string,
    scopes: string[],
  ): Promise<Grant> {
    const res = await this.fetch(
      "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
      { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`could not read the Microsoft profile (HTTP ${res.status})`);
    const me = (await res.json()) as { mail?: string | null; userPrincipalName?: string };
    const now = new Date().toISOString();
    return {
      version: 1,
      provider: "microsoft",
      purpose,
      address: me.mail || me.userPrincipalName || "",
      scopes,
      clientId: this.opts.clientId,
      tenant: this.opts.tenant,
      refreshToken,
      createdAt: now,
      updatedAt: now,
    };
  }

  private throwIfAdminConsent(body: TokenResponse): void {
    if (ADMIN_CONSENT.test(body.error_description ?? "")) {
      throw new AdminConsentRequiredError(this.opts.clientId);
    }
  }
}
