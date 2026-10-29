import { describe, expect, it } from "vitest";
import { safeWebLink, webLinkFor } from "../../src/fetcher/web-link.js";

describe("Open original links (FR-129, research R7)", () => {
  it("builds a Gmail search link for the Message-ID in the right account", () => {
    expect(
      webLinkFor("gmail-msgid", {
        accountEmail: "student@university.edu",
        messageId: "<abc+1@mail.x>",
      }),
    ).toBe(
      "https://mail.google.com/mail/u/student%40university.edu/#search/rfc822msgid%3Aabc%2B1%40mail.x",
    );
  });

  it("has no Gmail link without a Message-ID", () => {
    expect(webLinkFor("gmail-msgid", { accountEmail: "a@b.c", messageId: null })).toBeNull();
  });

  it("keeps a Graph webLink on an allowed host", () => {
    const link =
      "https://outlook.office365.com/owa/?ItemID=AAMk%3D&exvsurl=1&viewmodel=ReadMessageItem";
    expect(
      webLinkFor("graph", { accountEmail: "a@b.c", messageId: null, providerLink: link }),
    ).toBe(link);
  });

  it.each([
    "http://outlook.office365.com/owa/?ItemID=1",
    "https://outlook.office365.com.evil.example/owa",
    "javascript:alert(1)",
    "not a url",
  ])("drops %s", (link) => {
    expect(safeWebLink(link)).toBeNull();
  });

  it("has no link for providers without one", () => {
    expect(webLinkFor(null, { accountEmail: "a@yahoo.com", messageId: "<x@y>" })).toBeNull();
  });
});
