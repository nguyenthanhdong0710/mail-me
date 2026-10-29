import { readFileSync } from "node:fs";
import { parseAndClean } from "../../../src/fetcher/clean.js";
import { toIncomingEmail } from "../../../src/fetcher/incoming.js";
import type { IncomingEmail } from "../../../src/domain/types.js";

export function calendarFixture(name: string): Buffer {
  return readFileSync(new URL(`./${name}.eml`, import.meta.url));
}

export async function calendarEmail(name: string): Promise<IncomingEmail> {
  const cleaned = await parseAndClean(calendarFixture(name), {
    maxBodyChars: 12_000,
    fallbackDate: new Date(),
  });
  return toIncomingEmail(
    { accountId: "school", mailbox: "INBOX", uidValidity: "1", uid: "1" },
    cleaned,
    { email: "student@university.edu", webLink: null },
  );
}
