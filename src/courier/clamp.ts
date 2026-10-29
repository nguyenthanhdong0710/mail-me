// Brief-style length limits, enforced in code so every report complies (FR-111, SC-105,
// contracts/report.contract.md).

export const BRIEF_LIMITS = {
  summarySentences: 2,
  summaryWords: 40,
  /** For text written without spaces. */
  summaryChars: 240,
  points: 3,
  pointWords: 15,
  pointChars: 120,
  excerptChars: 300,
} as const;

const SENTENCE_END = /(?<=[.!?。！？])\s+/u;

/** Text whose "words" are this long on average is written without spaces (e.g. Chinese, Thai). */
const NO_SPACE_WORD_LENGTH = 20;

export function firstSentences(text: string, n: number): string {
  return text.trim().split(SENTENCE_END).slice(0, n).join(" ");
}

/** Cuts to `maxWords` words, or to `maxChars` characters for text without spaces, adding `…`. */
export function clampWords(text: string, maxWords: number, maxChars: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  const words = t.split(" ");
  if (t.length / words.length > NO_SPACE_WORD_LENGTH) {
    const chars = [...t];
    return chars.length <= maxChars ? t : `${chars.slice(0, maxChars).join("").trimEnd()}…`;
  }
  if (words.length <= maxWords) return t;
  return `${words
    .slice(0, maxWords)
    .join(" ")
    .replace(/[\s,;:–—-]+$/u, "")}…`;
}

export function clampSummary(text: string): string {
  const L = BRIEF_LIMITS;
  return clampWords(firstSentences(text, L.summarySentences), L.summaryWords, L.summaryChars);
}

export function clampPoints(points: string[]): string[] {
  const L = BRIEF_LIMITS;
  return points.slice(0, L.points).map((p) => clampWords(p, L.pointWords, L.pointChars));
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
