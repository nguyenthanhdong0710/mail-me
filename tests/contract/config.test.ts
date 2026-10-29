import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../../src/config/load.js";
import { rawConfig, testEnv } from "../fakes/config.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test mutation helper

function errorOf(mutate: (c: Json) => void, env: NodeJS.ProcessEnv = testEnv): string {
  const raw = rawConfig() as Json;
  mutate(raw);
  try {
    parseConfig(raw, env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected config to be rejected");
}

describe("config schema", () => {
  it("accepts a minimal config and applies defaults", () => {
    const c = parseConfig(rawConfig(), testEnv);
    expect(c.accounts[0]).toMatchObject({
      id: "school",
      mailboxes: ["INBOX"],
      lookbackHours: 0,
      imap: { port: 993, secure: true, password: "imap-secret-123" },
    });
    expect(c.delivery.email).toMatchObject({
      to: "me@primary.example",
      from: "me@primary.example",
    });
    expect(c.delivery.telegram).toBeNull();
    expect(c.delivery.maxAttempts).toBe(10);
    expect(c.rules.confidence_threshold).toBe(0.7);
    expect(c.pollIntervalSeconds).toBe(300);
    expect(c.limits.max_body_chars).toBe(12000);
    expect(c.secrets).toContain("sk-openai-secret-789");
  });

  it("names the missing field", () => {
    expect(errorOf((c) => delete c.ai.target_language)).toContain("ai.target_language");
  });

  it("names the field inside arrays", () => {
    expect(errorOf((c) => (c.accounts[0].imap.port = 70000))).toContain("accounts[0].imap.port");
  });

  it("names the unset environment variable", () => {
    const env = { ...testEnv, SCHOOL_IMAP_PASSWORD: undefined };
    expect(errorOf(() => {}, env)).toBe(
      'Invalid config: accounts[0].imap.password_env — environment variable "SCHOOL_IMAP_PASSWORD" is not set',
    );
  });

  it("rejects unknown keys", () => {
    expect(errorOf((c) => (c.forward_to = "x@y.z"))).toMatch(/forward_to|Unrecognized/);
  });

  it("requires at least one delivery channel", () => {
    expect(errorOf((c) => (c.delivery.email.enabled = false))).toContain(
      "enable at least one channel",
    );
  });

  it("requires a sending account when email is enabled", () => {
    const msg = errorOf((c) => delete c.delivery.email.smtp);
    expect(msg).toContain('delivery.email — set exactly one sending account: "oauth"');
  });

  it("rejects duplicate account ids", () => {
    expect(errorOf((c) => c.accounts.push({ ...c.accounts[0] }))).toContain("unique");
  });

  it("resolves an optional Anthropic workspace id from the environment", () => {
    const raw = rawConfig() as Json;
    raw.ai.analyst.workspace_id_env = "ANTHROPIC_WORKSPACE_ID";
    const c = parseConfig(raw, { ...testEnv, ANTHROPIC_WORKSPACE_ID: "wrkspc_123" });
    expect(c.ai.analyst.workspaceId).toBe("wrkspc_123");
    expect(c.ai.gatekeeper.workspaceId).toBeUndefined();
    const msg = errorOf((c) => (c.ai.analyst.workspace_id_env = "ANTHROPIC_WORKSPACE_ID"));
    expect(msg).toContain(
      'ai.analyst.workspace_id_env — environment variable "ANTHROPIC_WORKSPACE_ID" is not set',
    );
  });

  it("reports invalid JSON from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mail-me-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ // comments are not JSON\n }");
    expect(() => loadConfig(path, testEnv)).toThrow(/not valid JSON/);
  });
});
