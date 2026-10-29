# Contract: AI Usage and Cost Logging (002, FR-121–123)

## LlmClient (changed)

```ts
type LlmRole = "gatekeeper" | "analyst" | "scheduler";

interface LlmUsage {
  input: number;
  output: number;
  provider: string;
  model: string;
  ms: number;
  costUsd: number | null;   // null = no known price
}
```

`AiSdkLlmClient.generate` measures latency, reads `result.usage`, calls `estimateCost`, and logs
one line per call, including failed calls that returned usage (failed calls without usage log
`tokensIn: 0, tokensOut: 0, costUsd: 0` and `error`).

## Pricing

```ts
interface ModelPrice { input_per_mtok: number; output_per_mtok: number }
// src/agents/prices.ts
export const PRICES_AS_OF: string;                                  // e.g. "2026-11-02"
export const BUILT_IN_PRICES: Record<string, ModelPrice>;           // key: "<provider>/<model>"
export function estimateCost(
  provider: string, model: string, usage: { input: number; output: number },
  overrides: Record<string, ModelPrice>,
): number | null;
```

Lookup: `overrides[model]` → `BUILT_IN_PRICES["<provider>/<model>"]` → longest key in the
built-in table that `"<provider>/<model>"` starts with → `null`. Cost =
`(input × input_per_mtok + output × output_per_mtok) / 1e6`, rounded to 6 decimals.

## Log lines (pino JSON)

Per AI call (`info`):

```json
{"msg":"ai call","account":"school","uid":"18f3…","role":"analyst","provider":"anthropic",
 "model":"claude-haiku-5-5","tokensIn":1834,"tokensOut":212,"ms":2140,"costUsd":0.002894}
```

Unknown price (`warn`, once per model per process):

```json
{"msg":"no price for model, cost unknown","provider":"openai","model":"my-finetune",
 "hint":"set ai.prices[\"my-finetune\"] = { \"input_per_mtok\": …, \"output_per_mtok\": … } in config.json"}
```

Per email (existing `email reported` / `email skipped` lines gain fields):

```json
{"msg":"email reported", …, "tokens":{"input":2410,"output":398},"aiCalls":3,"costUsd":0.003512}
```

- `costUsd` = sum of the email's calls; `null` if any call's cost is `null` (SC-108).
- Rules-only paths (self-sent, drop keyword, whitelist with Scheduler disabled): `aiCalls: 0`, `costUsd: 0`.
- Startup line includes `pricesAsOf` and the note `"costs are estimates"`.
- `processed_messages.cost_usd` stores the same total.

## Tests

- `estimateCost`: override beats built-in, prefix match, unknown → null, rounding.
- Pipeline with fake LLM returning fixed usage: three call lines and an email line whose `costUsd`
  equals their sum; unknown model → `null` total and exactly one warning across two emails.
