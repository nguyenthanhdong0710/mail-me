import { readFileSync } from "node:fs";

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`./emails/${name}`, import.meta.url));
}

/** Builds a small RFC 5322 message for tests. */
export function eml(opts: {
  from?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  headers?: Record<string, string>;
}): string {
  const headers = {
    From: opts.from ?? "Alice <alice@university.edu>",
    To: "student@university.edu",
    Subject: opts.subject ?? "Hello",
    Date: "Wed, 28 Oct 2026 09:00:00 +0000",
    "Message-ID": opts.messageId ?? `<${Math.random().toString(36).slice(2)}@test>`,
    "MIME-Version": "1.0",
    "Content-Type": "text/plain; charset=utf-8",
    ...opts.headers,
  };
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return `${head}\r\n\r\n${opts.body ?? "Please reply by Friday."}\r\n`;
}
