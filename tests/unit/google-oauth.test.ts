import { describe, expect, it } from "vitest";
import { SignInCancelledError } from "../../src/auth/errors.js";
import { GoogleOAuthClient } from "../../src/auth/google.js";
import { InvalidGrantError } from "../../src/auth/token-endpoint.js";
import type { SignInIO } from "../../src/domain/ports.js";
import { FakeApi } from "../fakes/http.js";
import { sampleGrant } from "../fakes/grants.js";

const READ = "https://www.googleapis.com/auth/gmail.readonly";

function googleApi(scope = READ) {
  return new FakeApi()
    .on("POST", /oauth2\.googleapis\.com\/token$/, (c) => {
      const form = new URLSearchParams(c.body);
      if (form.get("grant_type") === "refresh_token") {
        return form.get("refresh_token") === "dead"
          ? {
              status: 400,
              json: {
                error: "invalid_grant",
                error_description: "Token has been expired or revoked.",
              },
            }
          : { json: { access_token: "ya29.new", expires_in: 3599, scope } };
      }
      return {
        json: {
          access_token: "ya29.first",
          refresh_token: "1//refresh",
          expires_in: 3599,
          scope,
          id_token: `x.${Buffer.from(JSON.stringify({ email: "me@gmail.com" })).toString("base64url")}.y`,
        },
      };
    })
    .on("GET", /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile$/, {
      json: { emailAddress: "student@university.edu", historyId: "1" },
    });
}

/** IO that answers the paste prompt with `reply(authUrl)` once the consent URL was printed. */
function pastingIO(reply: (authUrl: URL) => string): SignInIO & { out: string[] } {
  const out: string[] = [];
  let pasted = false;
  return {
    out,
    print: (l) => out.push(l),
    readLine: async () => {
      if (pasted) return new Promise(() => {});
      pasted = true;
      const url = out.find((l) => l.includes("accounts.google.com"))!.trim();
      return reply(new URL(url));
    },
  };
}

const client = (api: FakeApi, port = 0) =>
  new GoogleOAuthClient({
    clientId: "client-1.apps.googleusercontent.com",
    clientSecret: "secret",
    port,
    listenHost: "127.0.0.1",
    fetch: api.fetch,
    timeoutMs: 5000,
  });

describe("GoogleOAuthClient (research R3)", () => {
  it("asks only for gmail.readonly with PKCE, state and offline access", () => {
    const url = new URL(client(googleApi(), 53682).authUrl("read", "st4te", "ch4llenge"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      scope: READ,
      code_challenge: "ch4llenge",
      code_challenge_method: "S256",
      state: "st4te",
      access_type: "offline",
      prompt: "consent",
      redirect_uri: "http://127.0.0.1:53682/",
      response_type: "code",
    });
  });

  it("asks only for gmail.send (plus identity) for the email channel", () => {
    const url = new URL(client(googleApi()).authUrl("send", "s", "c"));
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.send openid email",
    );
  });

  it("completes from a pasted redirect address and confirms the account", async () => {
    const api = googleApi();
    const io = pastingIO(
      (auth) => `http://127.0.0.1:53682/?state=${auth.searchParams.get("state")}&code=4/abc`,
    );
    const grant = await client(api).signIn("read", io);
    expect(grant).toMatchObject({
      provider: "google",
      purpose: "read",
      address: "student@university.edu",
      scopes: [READ],
      refreshToken: "1//refresh",
    });
    const exchange = new URLSearchParams(api.callsTo(/oauth2\.googleapis\.com\/token/)[0]!.body);
    expect(exchange.get("code")).toBe("4/abc");
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("takes the address of a send grant from the ID token", async () => {
    const api = googleApi("https://www.googleapis.com/auth/gmail.send openid email");
    const io = pastingIO(
      (auth) => `http://127.0.0.1/?state=${auth.searchParams.get("state")}&code=c`,
    );
    expect((await client(api).signIn("send", io)).address).toBe("me@gmail.com");
  });

  it("ignores an address from another sign-in attempt", async () => {
    const out: string[] = [];
    const answers = ["http://127.0.0.1/?state=old&code=c", "not a url"];
    const io: SignInIO = {
      print: (l) => out.push(l),
      readLine: async () => answers.shift() ?? new Promise<string>(() => {}),
    };
    const c = new GoogleOAuthClient({
      clientId: "id",
      clientSecret: "s",
      port: 0,
      listenHost: "127.0.0.1",
      fetch: googleApi().fetch,
      timeoutMs: 50,
    });
    await expect(c.signIn("read", io)).rejects.toBeInstanceOf(SignInCancelledError);
    expect(out.join("\n")).toContain("belongs to a different sign-in attempt");
  });

  it("completes through the loopback listener", async () => {
    const api = googleApi();
    const port = 40000 + Math.floor(Math.random() * 20000);
    const out: string[] = [];
    const io: SignInIO = {
      print: (l) => {
        out.push(l);
        if (l.startsWith("Waiting for the browser")) {
          const state = new URL(
            out.find((x) => x.includes("accounts.google.com"))!.trim(),
          ).searchParams.get("state");
          setTimeout(() => void fetch(`http://127.0.0.1:${port}/?state=${state}&code=4/loop`), 10);
        }
      },
      readLine: () => new Promise(() => {}),
    };
    const grant = await client(api, port).signIn("read", io);
    expect(grant.address).toBe("student@university.edu");
  });

  it("refreshes, and reports a revoked grant as InvalidGrantError", async () => {
    const api = googleApi();
    const r = await client(api).refresh(sampleGrant());
    expect(r.accessToken).toBe("ya29.new");
    await expect(client(api).refresh(sampleGrant({ refreshToken: "dead" }))).rejects.toBeInstanceOf(
      InvalidGrantError,
    );
  });
});
