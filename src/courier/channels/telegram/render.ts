import type { Report } from "../../../domain/types.js";
import { formatSender } from "../../report.js";

/** Telegram allows 4096 characters per message; we keep a margin (research R14). */
export const TELEGRAM_LIMIT = 4000;
/** Room for the `(i/N)` label on split parts. */
const LABEL_RESERVE = 12;
/** The excerpt is never shortened below this before splitting kicks in. */
const MIN_EXCERPT = 200;

const QUOTE: [string, string] = ["<blockquote expandable>", "</blockquote>"];

/** Telegram's HTML parse mode only needs `& < >` escaped (core.telegram.org/bots/api#html-style). */
export function escapeTelegram(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One unit of the message. `html` is the formatted line(s); `plain` is the same content without
 * formatting, used only if the block alone is too long for a message and must be cut. `wrap`
 * re-applies a container tag (the excerpt blockquote) to every piece of a cut block.
 */
interface Block {
  html: string;
  plain: string;
  wrap?: [string, string];
}

const line = (html: string, plain: string): Block => ({ html, plain });
const BLANK = line("", "");

function excerptBlock(excerpt: string): Block {
  return { html: `${QUOTE[0]}${escapeTelegram(excerpt)}${QUOTE[1]}`, plain: excerpt, wrap: QUOTE };
}

function headerBlocks(report: Report): Block[] {
  const e = escapeTelegram;
  const subject = report.original.subject;
  const sender = formatSender(report.original.from);
  const title =
    report.kind === "FALLBACK"
      ? line(`<b>[Not summarized] ${e(subject)}</b>`, `[Not summarized] ${subject}`)
      : line(
          `${report.urgent ? "🔴 " : ""}<b>[AI Summary] ${e(subject)}</b>`,
          `${report.urgent ? "🔴 " : ""}[AI Summary] ${subject}`,
        );
  return [
    title,
    line(
      `📥 ${e(report.source.label)} · ✉️ ${e(sender)}`,
      `📥 ${report.source.label} · ✉️ ${sender}`,
    ),
    BLANK,
  ];
}

function bodyBlocks(report: Report): Block[] {
  const e = escapeTelegram;
  const a = report.analysis;
  const blocks: Block[] = [];
  if (!a) {
    blocks.push(line("⚠️ <b>AI summary unavailable</b>", "⚠️ AI summary unavailable"), BLANK);
  } else {
    blocks.push(line(`<b>TL;DR:</b> ${e(a.summary)}`, `TL;DR: ${a.summary}`), BLANK);
    if (a.key_points.length > 0) {
      blocks.push(line("<b>Key points</b>", "Key points"));
      blocks.push(...a.key_points.map((p) => line(`• ${e(p)}`, `• ${p}`)), BLANK);
    }
    if (a.action_items.length > 0) {
      blocks.push(line("<b>Action items</b>", "Action items"));
      for (const item of a.action_items) {
        blocks.push(
          item.deadline
            ? line(
                `☐ ${e(item.action)} — <i>${e(item.deadline)}</i>`,
                `☐ ${item.action} — ${item.deadline}`,
              )
            : line(`☐ ${e(item.action)}`, `☐ ${item.action}`),
        );
      }
      blocks.push(BLANK);
    }
    const yesNo = report.actionNeeded ? "Yes" : "No";
    blocks.push(line(`<b>Action needed:</b> ${yesNo}`, `Action needed: ${yesNo}`));
  }
  if (report.truncated) {
    blocks.push(
      line("<i>(content truncated before processing)</i>", "(content truncated before processing)"),
    );
  }
  return blocks;
}

const joinedLength = (blocks: Block[]) =>
  blocks.reduce((n, b) => n + b.html.length, 0) + Math.max(0, blocks.length - 1);

/** Cuts text so its escaped form fits in `max`, preferring a whitespace boundary. */
function cutEscaped(text: string, max: number): [string, string] {
  let size = 0;
  let end = 0;
  for (const ch of text) {
    const add = escapeTelegram(ch).length;
    if (size + add > max) break;
    size += add;
    end += ch.length;
  }
  if (end >= text.length) return [text, ""];
  const space = text.lastIndexOf(" ", end);
  if (space > end / 2) end = space + 1;
  return [text.slice(0, end), text.slice(end)];
}

/** Splits one oversize block into pieces that each fit, keeping every tag balanced. */
function splitBlock(block: Block, max: number): Block[] {
  const [open, close] = block.wrap ?? ["", ""];
  const room = max - open.length - close.length;
  const pieces: Block[] = [];
  let rest = block.plain;
  while (rest.length > 0) {
    const [head, tail] = cutEscaped(rest, room);
    pieces.push({ html: `${open}${escapeTelegram(head)}${close}`, plain: head });
    rest = tail;
  }
  return pieces;
}

/** Greedy packing of blocks into messages, splitting only at block (line) boundaries. */
function pack(blocks: Block[], max: number): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    while (current.length > 0 && current[current.length - 1] === "") current.pop();
    if (current.length > 0) parts.push(current.join("\n"));
    current = [];
    size = 0;
  };
  for (const block of blocks.flatMap((b) => (b.html.length > max ? splitBlock(b, max) : [b]))) {
    const add = block.html.length + (current.length > 0 ? 1 : 0);
    if (size + add > max) flush();
    if (current.length === 0 && block.html === "") continue;
    current.push(block.html);
    size += block.html.length + (current.length > 1 ? 1 : 0);
  }
  flush();
  return parts;
}

/**
 * Renders a report as one or more Telegram HTML messages (FR-023). Step 1 shortens the excerpt
 * so the report fits in one message; step 2 splits at line boundaries into `(i/N)` parts.
 */
export function renderTelegram(report: Report, limit = TELEGRAM_LIMIT): string[] {
  const fixed = [...headerBlocks(report), ...bodyBlocks(report)];
  let excerpt = report.excerpt;
  if (excerpt) {
    const room = limit - joinedLength(fixed) - 2 - QUOTE[0].length - QUOTE[1].length;
    if (escapeTelegram(excerpt).length > room) {
      const keep = Math.max(MIN_EXCERPT, room - 1);
      const [head] = cutEscaped(excerpt, keep);
      excerpt = `${head.trimEnd()}…`;
    }
  }
  const blocks = excerpt ? [...fixed, BLANK, excerptBlock(excerpt)] : fixed;

  if (joinedLength(blocks) <= limit) return pack(blocks, limit);
  const parts = pack(blocks, limit - LABEL_RESERVE);
  return parts.map((p, i) => `(${i + 1}/${parts.length})\n${p}`);
}
