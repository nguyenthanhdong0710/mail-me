// Built-in model prices for cost estimates (002 research R13, contracts/ai-usage.contract.md).
// Values are public list prices in USD per million tokens on PRICES_AS_OF. They go out of date;
// users override or add models with `ai.prices` in config.json.

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

export const PRICES_AS_OF = "2026-10-30";

/** Keyed by `<provider>/<model>`; a key also covers dated snapshot IDs that start with it. */
export const BUILT_IN_PRICES: Record<string, ModelPrice> = {
  // platform.claude.com/docs/en/about-claude/pricing (Haiku 5.5: prompts up to 100k tokens)
  "anthropic/claude-fable-5-1": { input_per_mtok: 10, output_per_mtok: 50 },
  "anthropic/claude-fable-5": { input_per_mtok: 10, output_per_mtok: 50 },
  "anthropic/claude-opus-5-5": { input_per_mtok: 4, output_per_mtok: 20 },
  "anthropic/claude-opus-5": { input_per_mtok: 5, output_per_mtok: 25 },
  "anthropic/claude-opus-4-8": { input_per_mtok: 5, output_per_mtok: 25 },
  "anthropic/claude-opus-4-7": { input_per_mtok: 5, output_per_mtok: 25 },
  "anthropic/claude-opus-4-6": { input_per_mtok: 5, output_per_mtok: 25 },
  "anthropic/claude-opus-4-5": { input_per_mtok: 5, output_per_mtok: 25 },
  "anthropic/claude-sonnet-5-5": { input_per_mtok: 2, output_per_mtok: 10 },
  "anthropic/claude-sonnet-5": { input_per_mtok: 2, output_per_mtok: 10 },
  "anthropic/claude-sonnet-4-6": { input_per_mtok: 3, output_per_mtok: 15 },
  "anthropic/claude-sonnet-4-5": { input_per_mtok: 3, output_per_mtok: 15 },
  "anthropic/claude-haiku-5-5": { input_per_mtok: 0.1, output_per_mtok: 0.5 },
  "anthropic/claude-haiku-4-5": { input_per_mtok: 1, output_per_mtok: 5 },
  // developers.openai.com/api/docs/pricing (standard tier, short context)
  "openai/gpt-5.6-sol": { input_per_mtok: 4, output_per_mtok: 20 },
  "openai/gpt-5.6-terra": { input_per_mtok: 2, output_per_mtok: 12 },
  "openai/gpt-5.6-luna": { input_per_mtok: 0.2, output_per_mtok: 1.2 },
  "openai/gpt-5.5": { input_per_mtok: 5, output_per_mtok: 30 },
  "openai/gpt-5.4": { input_per_mtok: 2.5, output_per_mtok: 15 },
  "openai/gpt-5.4-mini": { input_per_mtok: 0.75, output_per_mtok: 4.5 },
  "openai/gpt-5.4-nano": { input_per_mtok: 0.2, output_per_mtok: 1.25 },
  "openai/gpt-5.2": { input_per_mtok: 1.75, output_per_mtok: 14 },
  "openai/gpt-5.1": { input_per_mtok: 1.25, output_per_mtok: 10 },
  "openai/gpt-5": { input_per_mtok: 1.25, output_per_mtok: 10 },
  "openai/gpt-5-mini": { input_per_mtok: 0.25, output_per_mtok: 2 },
  "openai/gpt-5-nano": { input_per_mtok: 0.05, output_per_mtok: 0.4 },
  "openai/gpt-4.1": { input_per_mtok: 2, output_per_mtok: 8 },
  "openai/gpt-4.1-mini": { input_per_mtok: 0.4, output_per_mtok: 1.6 },
  "openai/gpt-4.1-nano": { input_per_mtok: 0.1, output_per_mtok: 0.4 },
  "openai/o3": { input_per_mtok: 2, output_per_mtok: 8 },
  "openai/o3-mini": { input_per_mtok: 1.1, output_per_mtok: 4.4 },
  "openai/o4-mini": { input_per_mtok: 1.1, output_per_mtok: 4.4 },
  // ai.google.dev/gemini-api/docs/pricing (paid tier, prompts up to 200k tokens; several
  // rise on 2026-12-01 and 2027-01-01)
  "google/gemini-4-argon": { input_per_mtok: 2, output_per_mtok: 10 },
  "google/gemini-3.8-flash": { input_per_mtok: 0.75, output_per_mtok: 3.75 },
  "google/gemini-3.6-flash": { input_per_mtok: 0.75, output_per_mtok: 3.75 },
  "google/gemini-3.5-flash-lite": { input_per_mtok: 0.3, output_per_mtok: 2.5 },
  "google/gemini-3.1-flash-lite": { input_per_mtok: 0.25, output_per_mtok: 1.5 },
  "google/gemini-3.1-pro-preview": { input_per_mtok: 2, output_per_mtok: 12 },
  "google/gemini-3-flash-preview": { input_per_mtok: 0.5, output_per_mtok: 3 },
  "google/gemini-2.5-pro": { input_per_mtok: 1.25, output_per_mtok: 10 },
  "google/gemini-2.5-flash": { input_per_mtok: 0.3, output_per_mtok: 2.5 },
  "google/gemini-2.5-flash-lite": { input_per_mtok: 0.1, output_per_mtok: 0.4 },
};

/**
 * Estimated cost of one call, or null when the model has no known price. Lookup order: the
 * user's override for the model ID, the exact built-in key, then the longest built-in prefix.
 */
export function estimateCost(
  provider: string,
  model: string,
  usage: { input: number; output: number },
  overrides: Record<string, ModelPrice> = {},
  builtIn: Record<string, ModelPrice> = BUILT_IN_PRICES,
): number | null {
  const price = overrides[model] ?? findBuiltIn(`${provider}/${model}`, builtIn);
  if (!price) return null;
  const cost = (usage.input * price.input_per_mtok + usage.output * price.output_per_mtok) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

function findBuiltIn(key: string, table: Record<string, ModelPrice>): ModelPrice | undefined {
  if (table[key]) return table[key];
  let best: string | undefined;
  for (const candidate of Object.keys(table)) {
    // A prefix only counts at an ID boundary, so "gpt-5" never prices "gpt-50".
    const next = key.charAt(candidate.length);
    const boundary = next === "" || next === "-" || next === "@";
    if (key.startsWith(candidate) && boundary && (!best || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best ? table[best] : undefined;
}
