import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Grant, GrantPurpose, HttpFetch, OAuthClient, SignInIO } from "../domain/ports.js";
import { SignInCancelledError } from "./errors.js";
import { REQUESTED_SCOPES } from "./scopes.js";
import { postForm, refreshError, splitScopes } from "./token-endpoint.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
/** `gmail.send` cannot read the profile, so a send grant learns its address from the ID token. */
const SEND_IDENTITY_SCOPES = ["openid", "email"];

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Loopback port (published from Docker as-is). */
  port: number;
  /** Interface the listener binds; 0.0.0.0 inside a container (contracts/auth-cli.contract.md). */
  listenHost: string;
  /** Pre-fills the account on Google's sign-in page. */
  loginHint?: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}

/**
 * Google OAuth for a "Desktop app" client (002 research R3): authorization code with PKCE and a
 * loopback redirect. The browser may be on another machine, so the redirect address can also be
 * pasted; whichever arrives first wins.
 */
export class GoogleOAuthClient implements OAuthClient {
  readonly provider = "google" as const;
  private readonly fetch: HttpFetch;

  constructor(private readonly opts: GoogleOAuthOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  get redirectUri(): string {
    return `http://127.0.0.1:${this.opts.port}/`;
  }

  /** The consent URL, exposed for tests. */
  authUrl(purpose: GrantPurpose, state: string, challenge: string): string {
    const scopes = [
      ...REQUESTED_SCOPES.google[purpose],
      ...(purpose === "send" ? SEND_IDENTITY_SCOPES : []),
    ];
    const q = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
      ...(this.opts.loginHint && { login_hint: this.opts.loginHint }),
    });
    return `${AUTH_URL}?${q}`;
  }

  async signIn(purpose: GrantPurpose, io: SignInIO): Promise<Grant> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    io.print("Open this link in a browser where you can sign in to the account:");
    io.print(`  ${this.authUrl(purpose, state, challenge)}`);
    io.print("");
    const code = await this.waitForCode(state, io);

    const { status, body } = await postForm(this.fetch, TOKEN_URL, {
      code,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (status !== 200 || !body.access_token) throw refreshError(status, body);
    if (!body.refresh_token) {
      throw new Error("Google returned no refresh token. Run the command again.");
    }
    const scopes = splitScopes(body.scope);
    const address =
      purpose === "read"
        ? await this.profileAddress(body.access_token, scopes)
        : idTokenEmail(body.id_token);
    const now = new Date().toISOString();
    return {
      version: 1,
      provider: "google",
      purpose,
      address,
      scopes,
      clientId: this.opts.clientId,
      refreshToken: body.refresh_token,
      createdAt: now,
      updatedAt: now,
    };
  }

  async refresh(grant: Grant): Promise<{ accessToken: string; expiresAt: Date }> {
    const { status, body } = await postForm(this.fetch, TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    if (status !== 200 || !body.access_token) throw refreshError(status, body);
    return {
      accessToken: body.access_token,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
    };
  }

  private async profileAddress(accessToken: string, scopes: string[]): Promise<string> {
    // Without the read scope the profile call fails; the caller reports the missing scope.
    if (!scopes.includes(REQUESTED_SCOPES.google.read[0]!)) return "";
    const res = await this.fetch(PROFILE_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`could not read the Gmail profile (HTTP ${res.status})`);
    return ((await res.json()) as { emailAddress: string }).emailAddress;
  }

  /** Resolves with the authorization code from the loopback callback or a pasted address. */
  private waitForCode(state: string, io: SignInIO): Promise<string> {
    return new Promise((resolve, reject) => {
      let server: Server | null = null;
      let done = false;
      const finish = (err: Error | null, code?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        server?.close();
        if (err) reject(err);
        else resolve(code!);
      };
      const handle = (url: URL): string | null => {
        if (url.searchParams.get("error")) {
          finish(new SignInCancelledError(url.searchParams.get("error") ?? undefined));
          return "Sign-in was cancelled. You can close this tab.";
        }
        const code = url.searchParams.get("code");
        if (!code) return null;
        if (url.searchParams.get("state") !== state) {
          io.print("✗ That address belongs to a different sign-in attempt. Paste the latest one.");
          return "This sign-in link is out of date. Start again from the terminal.";
        }
        finish(null, code);
        return "Signed in. You can close this tab and return to the terminal.";
      };

      const timer = setTimeout(
        () => finish(new SignInCancelledError()),
        this.opts.timeoutMs ?? 15 * 60_000,
      );

      server = createServer((req, res) => {
        const message = handle(new URL(req.url ?? "/", this.redirectUri));
        res.writeHead(message ? 200 : 404, { "content-type": "text/plain; charset=utf-8" });
        res.end(message ?? "Not found");
      });
      server.on("error", (err) => {
        io.print(
          `(Could not listen on ${this.opts.listenHost}:${this.opts.port}: ${err.message}. Paste the address instead.)`,
        );
        server = null;
      });
      server.listen(this.opts.port, this.opts.listenHost);

      io.print(`Waiting for the browser on ${this.redirectUri} …`);
      io.print("If the browser is on another machine, it will end on a page that does not load.");
      io.print("Copy that page's full address and paste it here:");
      const ask = () => {
        void io.readLine().then((line) => {
          if (done) return;
          let url: URL;
          try {
            url = new URL(line.trim());
          } catch {
            io.print("✗ That is not an address. Paste the full address from the browser:");
            return ask();
          }
          if (handle(url) === null) {
            io.print(
              "✗ That address has no sign-in code. Paste the full address from the browser:",
            );
            ask();
          } else if (!done) {
            ask();
          }
        });
      };
      ask();
    });
  }
}

/** Reads `email` from an ID token we just received from Google's token endpoint over TLS. */
function idTokenEmail(idToken: unknown): string {
  if (typeof idToken !== "string") return "";
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString(),
    ) as {
      email?: string;
    };
    return payload.email ?? "";
  } catch {
    return "";
  }
}
