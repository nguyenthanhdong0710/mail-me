import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import type { ZodType } from "zod";
import type { ModelConfig } from "../config/load.js";
import { LlmError, type LlmClient, type LlmRole } from "../domain/ports.js";
import type { LlmUsage } from "../domain/types.js";
import { Semaphore } from "../lib/retry.js";

export function createModel(cfg: ModelConfig): LanguageModel {
  switch (cfg.provider) {
    case "openai":
      return createOpenAI({ apiKey: cfg.apiKey })(cfg.model);
    case "anthropic":
      return createAnthropic({ apiKey: cfg.apiKey })(cfg.model);
    case "google":
      return createGoogle({ apiKey: cfg.apiKey })(cfg.model);
  }
}

const TEMPERATURE: Record<LlmRole, number> = { gatekeeper: 0, analyst: 0.2 };

/** AI SDK adapter: structured output per role, re-validated with our own schema (research R4). */
export class AiSdkLlmClient implements LlmClient {
  private readonly models: Record<LlmRole, LanguageModel>;
  private readonly semaphore: Semaphore;

  constructor(
    cfg: { gatekeeper: ModelConfig; analyst: ModelConfig },
    concurrency: number,
    modelFactory: (cfg: ModelConfig) => LanguageModel = createModel,
  ) {
    // Each role gets its own provider and model (constitution II, FR-015).
    this.models = { gatekeeper: modelFactory(cfg.gatekeeper), analyst: modelFactory(cfg.analyst) };
    this.semaphore = new Semaphore(concurrency);
  }

  generate<T>(
    role: LlmRole,
    args: { system: string; user: string; schema: ZodType<T> },
  ): Promise<{ value: T; usage: LlmUsage }> {
    return this.semaphore.run(async () => {
      let result;
      try {
        result = await generateText({
          model: this.models[role],
          instructions: args.system,
          prompt: args.user,
          output: Output.object({ schema: args.schema }),
          temperature: TEMPERATURE[role],
          maxRetries: 0, // retries are handled by the caller with backoff
        });
      } catch (err) {
        throw new LlmError(`${role} call failed: ${(err as Error).message}`, { cause: err });
      }
      const parsed = args.schema.safeParse(result.output);
      if (!parsed.success) throw new LlmError(`${role} returned output that fails the schema`);
      return {
        value: parsed.data,
        usage: { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 },
      };
    });
  }
}
