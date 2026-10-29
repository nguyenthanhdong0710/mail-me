import { readFileSync } from "node:fs";
import type { Address } from "../domain/types.js";

const cache = new Map<string, string>();

/** Prompts are versioned files next to this module (copied into dist/ by the build). */
export function loadPrompt(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
    cache.set(name, text);
  }
  return text;
}

/** Keeps untrusted content from closing or opening our data tags (research R5). */
export function neutralizeTags(value: string): string {
  return value.replace(/<(\/?)(email|from|subject|body|attachments|truncated)\b/gi, "‹$1$2");
}

export function emailBlock(email: {
  from: Address;
  subject: string;
  text: string;
  attachments?: string[];
}): string {
  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const lines = [
    "<email>",
    `<from>${neutralizeTags(from)}</from>`,
    `<subject>${neutralizeTags(email.subject)}</subject>`,
  ];
  if (email.attachments && email.attachments.length > 0) {
    lines.push(`<attachments>${neutralizeTags(email.attachments.join(", "))}</attachments>`);
  }
  lines.push(`<body>\n${neutralizeTags(email.text)}\n</body>`, "</email>");
  return lines.join("\n");
}
