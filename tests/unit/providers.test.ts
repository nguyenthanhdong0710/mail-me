import { describe, expect, it } from "vitest";
import { PROVIDER_NAMES, preset } from "../../src/config/providers.js";

describe("provider presets (FR-107, SC-104)", () => {
  it("ships at least 8 named providers plus custom", () => {
    const named = PROVIDER_NAMES.filter((n) => n !== "custom");
    expect(named).toEqual(
      expect.arrayContaining([
        "gmail",
        "microsoft",
        "yahoo",
        "icloud",
        "fastmail",
        "zoho",
        "gmx",
        "aol",
      ]),
    );
  });

  it("uses OAuth by default for Gmail and only OAuth for Microsoft", () => {
    expect(preset("gmail").authMethods[0]).toBe("oauth");
    expect(preset("gmail").authMethods).toContain("password");
    expect(preset("microsoft").authMethods).toEqual(["oauth"]);
    expect(preset("microsoft").imap).toBeNull();
  });

  it("gives every password provider an encrypted IMAP server", () => {
    for (const name of PROVIDER_NAMES) {
      const p = preset(name);
      if (!p.authMethods.includes("password") || name === "custom") continue;
      expect(p.imap, name).toMatchObject({ port: 993, secure: true });
      expect(p.smtp, name).not.toBeNull();
    }
  });

  it("only links to the original message for Gmail and Microsoft", () => {
    const withLinks = PROVIDER_NAMES.filter((n) => preset(n).webLink !== null);
    expect(withLinks.sort()).toEqual(["gmail", "microsoft"]);
  });
});
