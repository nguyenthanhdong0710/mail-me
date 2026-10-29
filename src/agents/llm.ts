import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import type { ZodType } from "zod";
import type { ModelConfig } from "../config/load.js";
import { LlmError, type LlmClient, type LlmRole } from "../domain/ports.js";
import type { LlmUsage } from "../domain/types.js";
import type { Logger } from "../lib/logger.js";
import { Semaphore } from "../lib/retry.js";
import { estimateCost, type ModelPrice } from "./prices.js";

export function createModel(cfg: ModelConfig): LanguageModel {
  switch (cfg.provider) {
    case "openai":
      return createOpenAI({ apiKey: cfg.apiKey })(cfg.model);
    case "anthropic":
      return createAnthropic({
        apiKey: cfg.apiKey,
        headers: cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : undefined,
      })(cfg.model);
    case "google":
      return createGoogle({ apiKey: cfg.apiKey })(cfg.model);
  }
}

const TEMPERATURE: Record<LlmRole, number> = { gatekeeper: 0, analyst: 0.2, scheduler: 0 };

export interface LlmRoles {
  gatekeeper: ModelConfig;
  analyst: ModelConfig;
  /** Absent when the Scheduler is disabled. */
  scheduler?: ModelConfig | null;
}

export interface LlmClientOptions {
  concurrency: number;
  /** User price overrides (`ai.prices`), keyed by model ID. */
  prices?: Record<string, ModelPrice>;
  /** Receives one `ai call` line per call (contracts/ai-usage.contract.md). */
  logger?: Logger;
  modelFactory?: (cfg: ModelConfig) => LanguageModel;
  now?: () => number;
}

/** AI SDK adapter: structured output per role, re-validated with our own schema (research R4). */
export class AiSdkLlmClient implements LlmClient {
  private readonly models: Partial<Record<LlmRole, { model: LanguageModel; cfg: ModelConfig }>>;
  private readonly semaphore: Semaphore;
  /** Models already warned about a missing price, so each warns once per process. */
  private readonly unpriced = new Set<string>();
  private readonly now: () => number;

  constructor(
    roles: LlmRoles,
    private readonly opts: LlmClientOptions,
  ) {
    const factory = opts.modelFactory ?? createModel;
    // Each role gets its own provider and model (constitution II, FR-015, FR-113).
    this.models = {
      gatekeeper: { model: factory(roles.gatekeeper), cfg: roles.gatekeeper },
      analyst: { model: factory(roles.analyst), cfg: roles.analyst },
      ...(roles.scheduler && {
        scheduler: { model: factory(roles.scheduler), cfg: roles.scheduler },
      }),
    };
    this.semaphore = new Semaphore(opts.concurrency);
    this.now = opts.now ?? Date.now;
  }

  generate<T>(
    role: LlmRole,
    args: { system: string; user: string; schema: ZodType<T>; log?: Logger },
  ): Promise<{ value: T; usage: LlmUsage }> {
    const entry = this.models[role];
    if (!entry) return Promise.reject(new LlmError(`${role} is not configured`));
    return this.semaphore.run(async () => {
      const started = this.now();
      let result;
      try {
        result = await generateText({
          model: entry.model,
          instructions: args.system,
          prompt: args.user,
          output: Output.object({ schema: args.schema }),
          temperature: TEMPERATURE[role],
          maxRetries: 0, // retries are handled by the caller with backoff
        });
      } catch (err) {
        this.logCall(args.log, role, entry.cfg, { input: 0, output: 0 }, this.now() - started, err);
        throw new LlmError(`${role} call failed: ${(err as Error).message}`, { cause: err });
      }
      const usage = this.logCall(
        args.log,
        role,
        entry.cfg,
        { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 },
        this.now() - started,
      );
      const parsed = args.schema.safeParse(result.output);
      if (!parsed.success) throw new LlmError(`${role} returned output that fails the schema`);
      return { value: parsed.data, usage };
    });
  }

  /** Prices one call and writes its `ai call` log line (FR-121, FR-123). */
  private logCall(
    log: Logger | undefined,
    role: LlmRole,
    cfg: ModelConfig,
    tokens: { input: number; output: number },
    ms: number,
    error?: unknown,
  ): LlmUsage {
    const costUsd = error ? 0 : estimateCost(cfg.provider, cfg.model, tokens, this.opts.prices);
    if (costUsd === null && !this.unpriced.has(cfg.model)) {
      this.unpriced.add(cfg.model);
      this.opts.logger?.warn(
        {
          provider: cfg.provider,
          model: cfg.model,
          hint: `set ai.prices["${cfg.model}"] = { "input_per_mtok": …, "output_per_mtok": … } in config.json`,
        },
        "no price for model, cost unknown",
      );
    }
    (log ?? this.opts.logger)?.info(
      {
        role,
        provider: cfg.provider,
        model: cfg.model,
        tokensIn: tokens.input,
        tokensOut: tokens.output,
        ms,
        costUsd,
        ...(error !== undefined && { error: (error as Error).message }),
      },
      "ai call",
    );
    return { ...tokens, provider: cfg.provider, model: cfg.model, ms, costUsd };
  }
}
