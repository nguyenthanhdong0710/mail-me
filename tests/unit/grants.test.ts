import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileGrantStore, GrantFileError } from "../../src/auth/grants.js";
import { sampleGrant } from "../fakes/grants.js";

describe("FileGrantStore (FR-105)", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "mail-me-")), "grants");
  });
  afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  it("returns null when the grant does not exist", () => {
    expect(new FileGrantStore(dir).read("school.read")).toBeNull();
  });

  it("writes owner-only files atomically and reads them back", () => {
    const store = new FileGrantStore(dir);
    store.write("school.read", sampleGrant());
    expect(store.read("school.read")).toEqual(sampleGrant());
    if (process.platform !== "win32") {
      expect(statSync(store.path("school.read")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(dir)).toEqual(["school.read.json"]);
  });

  it.skipIf(process.platform === "win32")("refuses a file other users can read", () => {
    const store = new FileGrantStore(dir);
    store.write("school.read", sampleGrant());
    chmodSync(store.path("school.read"), 0o644);
    expect(() => store.read("school.read")).toThrow(GrantFileError);
    expect(() => store.read("school.read")).toThrow(/chmod 600/);
  });

  it("refuses bad JSON and unknown versions", () => {
    const store = new FileGrantStore(dir);
    store.write("a", sampleGrant());
    writeFileSync(store.path("a"), "{not json", { mode: 0o600 });
    expect(() => store.read("a")).toThrow(/not valid JSON/);
    writeFileSync(store.path("a"), JSON.stringify({ ...sampleGrant(), version: 2 }), {
      mode: 0o600,
    });
    expect(() => store.read("a")).toThrow(/not a Mail-Me grant file/);
  });
});
