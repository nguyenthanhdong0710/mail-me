import { createInterface } from "node:readline";
import type { AppConfig, GrantRef } from "../config/load.js";
import { grantRefs } from "../config/load.js";
import { sameMailbox } from "../config/address.js";
import type { GrantStore, OAuthClient, OAuthProvider, SignInIO } from "../domain/ports.js";
import { FileGrantStore } from "./grants.js";
import { PERMISSION_TEXT, scopeProblem } from "./scopes.js";

// `mail-me auth` (contracts/auth-cli.contract.md, FR-103).

export interface AuthArgs {
  accountId: string | null;
  emailChannel: boolean;
  status: boolean;
  port: number;
  listen: string;
}

export function parseAuthArgs(argv: string[]): AuthArgs {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const withValue = new Set(["--config", "--port", "--listen"]);
  const positional = argv.filter(
    (a, i) => !a.startsWith("--") && !withValue.has(argv[i - 1] ?? ""),
  );
  return {
    accountId: positional[0] ?? null,
    emailChannel: argv.includes("--email-channel"),
    status: argv.includes("--status"),
    port: Number(value("--port") ?? 53682),
    listen: value("--listen") ?? "127.0.0.1",
  };
}

export interface AuthDeps {
  config: AppConfig;
  io: SignInIO;
  /** Builds the provider's OAuth client from the config's OAuth app settings. */
  client: (provider: OAuthProvider, args: AuthArgs) => OAuthClient;
  store?: GrantStore;
}

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", microsoft: "Microsoft" };

/** Runs the command; returns the process exit code. */
export async function runAuth(args: AuthArgs, deps: AuthDeps): Promise<number> {
  const { config, io } = deps;
  const store = deps.store ?? new FileGrantStore(config.auth.grantsDir);

  if (args.status) return status(config, store, io);

  const target = resolveTarget(args, config);
  if ("error" in target) {
    io.print(`✗ ${target.error}`);
    return 2;
  }
  const { ref, label } = target;

  io.print(`Signing in ${label} (${ref.address}) with ${PROVIDER_LABEL[ref.provider]}.`);
  io.print(`Permission requested: ${PERMISSION_TEXT[ref.provider][ref.purpose]}`);
  io.print("");

  let grant;
  try {
    grant = await deps.client(ref.provider, args).signIn(ref.purpose, io);
  } catch (err) {
    io.print(`✗ ${(err as Error).message}`);
    return 1;
  }

  if (!sameMailbox(grant.address, ref.address)) {
    io.print(
      `✗ You signed in as ${grant.address}, but ${label} is ${ref.address}. Nothing was saved.`,
    );
    return 1;
  }
  const problem = scopeProblem(ref.provider, ref.purpose, grant.scopes);
  if (problem) {
    const allow = ref.purpose === "read" ? "Read your email" : "Send email";
    io.print(
      problem.endsWith("not granted")
        ? `✗ ${ref.purpose === "read" ? "Read" : "Send"} access was not granted. Run the command again and allow "${allow}". Nothing was saved.`
        : `✗ ${problem}. Nothing was saved.`,
    );
    return 1;
  }

  store.write(ref.name, grant);
  const what = ref.purpose === "read" ? "read-only mail access" : "send-only mail access";
  io.print(
    `✓ Signed in ${grant.address} with ${what}. Saved to ${store instanceof FileGrantStore ? store.path(ref.name) : ref.name}`,
  );
  return 0;
}

function resolveTarget(
  args: AuthArgs,
  config: AppConfig,
): { ref: GrantRef; label: string } | { error: string } {
  if (args.emailChannel) {
    const oauth = config.delivery.email?.oauth;
    if (!oauth) {
      return {
        error:
          'The email channel has no OAuth sender. Enable delivery.email and set "oauth" (see README "Only if you use email reports").',
      };
    }
    return { ref: oauth.grant, label: "the email channel" };
  }
  if (!args.accountId) return { error: "Name an account: mail-me auth <account-id>" };
  const account = config.accounts.find((a) => a.id === args.accountId);
  if (!account) return { error: `Account "${args.accountId}" not found` };
  if (!account.grant) {
    return {
      error: `Account "${account.id}" uses a password; OAuth is only for gmail and microsoft accounts.`,
    };
  }
  return { ref: account.grant, label: `"${account.id}"` };
}

function status(config: AppConfig, store: GrantStore, io: SignInIO): number {
  const refs = grantRefs(config);
  if (refs.length === 0) {
    io.print("No OAuth accounts in the config.");
    return 0;
  }
  let missing = 0;
  for (const { path, ref } of refs) {
    let line: string;
    try {
      const grant = store.read(ref.name);
      if (grant) {
        line = `✓ ${path}\t${grant.address}\t${grant.purpose === "read" ? "read-only" : "send-only"}\trenewed ${grant.updatedAt}`;
      } else {
        missing++;
        line = `✗ ${path}\tnot signed in. Run: ${ref.fixCommand}`;
      }
    } catch (err) {
      missing++;
      line = `✗ ${path}\t${(err as Error).message}`;
    }
    io.print(line);
  }
  return missing === 0 ? 0 : 1;
}

/** Terminal IO: prints to stdout and reads pasted lines from stdin. */
export function terminalIO(): SignInIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  return {
    print: (line) => console.log(line),
    readLine: () =>
      new Promise((resolve) => {
        const line = lines.shift();
        if (line !== undefined) resolve(line);
        else waiting.push(resolve);
      }),
    close: () => rl.close(),
  };
}
