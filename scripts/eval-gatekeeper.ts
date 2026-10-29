/**
 * Measures SC-003 on a labelled set of .eml files: 0 important emails dropped and at least
 * 80% of promotions and spam filtered. Runs the same deterministic rules and Gatekeeper as
 * the pipeline, against the AI provider in your config (this makes real, billed calls).
 *
 *   npx tsx scripts/eval-gatekeeper.ts <dir> [--config config.json]
 *
 * <dir> holds one sub-folder per label: important/, promotion/, spam/ (any of them may be absent).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { classify } from "../src/agents/gatekeeper.js";
import { AiSdkLlmClient } from "../src/agents/llm.js";
import { loadConfig } from "../src/config/load.js";
import type { Category } from "../src/domain/types.js";
import { parseAndClean } from "../src/fetcher/clean.js";
import { evaluateRules } from "../src/rules/engine.js";

export const LABELS = ["important", "promotion", "spam"] as const;
export type Label = (typeof LABELS)[number];

export interface Sample {
  file: string;
  label: Label;
  /** What the pipeline would do: forward (IMPORTANT) or filter (SPAM/PROMOTION). */
  predicted: Category;
  via: "WHITELIST" | "DROP_KEYWORD" | "LLM" | "LLM_FAILED";
}

export interface Score {
  total: number;
  importantDropped: Sample[];
  noise: number;
  noiseFiltered: number;
  filterRate: number;
  passed: boolean;
}

export function score(samples: Sample[]): Score {
  const importantDropped = samples.filter(
    (s) => s.label === "important" && s.predicted !== "IMPORTANT",
  );
  const noise = samples.filter((s) => s.label !== "important");
  const noiseFiltered = noise.filter((s) => s.predicted !== "IMPORTANT").length;
  const filterRate = noise.length === 0 ? 1 : noiseFiltered / noise.length;
  return {
    total: samples.length,
    importantDropped,
    noise: noise.length,
    noiseFiltered,
    filterRate,
    passed: importantDropped.length === 0 && filterRate >= 0.8,
  };
}

async function main(argv: string[]): Promise<number> {
  const dir = argv.find((a) => !a.startsWith("--"));
  const i = argv.indexOf("--config");
  if (!dir) {
    console.error("Usage: npx tsx scripts/eval-gatekeeper.ts <dir> [--config config.json]");
    return 2;
  }
  dotenv.config({ quiet: true });
  const config = loadConfig((i >= 0 ? argv[i + 1] : undefined) ?? "config.json");
  const llm = new AiSdkLlmClient(config.ai, config.limits.llm_concurrency);

  const samples: Sample[] = [];
  for (const label of LABELS) {
    let files: string[];
    try {
      files = readdirSync(join(dir, label)).filter((f) => f.endsWith(".eml"));
    } catch {
      continue;
    }
    for (const file of files) {
      const cleaned = await parseAndClean(readFileSync(join(dir, label, file)), {
        maxBodyChars: config.limits.max_body_chars,
        fallbackDate: new Date(),
      });
      const email = { accountId: "eval", mailbox: "INBOX", uidValidity: 0, uid: 0, ...cleaned };
      const decision = evaluateRules(email, {
        installId: "eval",
        isProcessed: () => false,
        rules: {
          whitelistDomains: config.rules.whitelist_domains,
          dropKeywords: config.rules.drop_keywords,
        },
      });
      let sample: Sample;
      if (decision.kind === "WHITELIST") {
        sample = { file, label, predicted: "IMPORTANT", via: "WHITELIST" };
      } else if (decision.kind === "DROP_KEYWORD") {
        sample = { file, label, predicted: "PROMOTION", via: "DROP_KEYWORD" };
      } else {
        const verdict = await classify(llm, email, {
          threshold: config.rules.confidence_threshold,
        });
        sample = {
          file,
          label,
          predicted: verdict.effective,
          via: verdict.failed ? "LLM_FAILED" : "LLM",
        };
      }
      samples.push(sample);
      const ok = (label === "important") === (sample.predicted === "IMPORTANT");
      console.log(`${ok ? "✓" : "✗"} ${label}/${file} → ${sample.predicted} (${sample.via})`);
    }
  }

  const s = score(samples);
  console.log(
    `\n${s.total} emails. Important dropped: ${s.importantDropped.length}. ` +
      `Noise filtered: ${s.noiseFiltered}/${s.noise} (${(s.filterRate * 100).toFixed(1)}%).`,
  );
  if (s.total < 50) console.log("Note: SC-003 asks for a set of at least 50 emails.");
  console.log(s.passed ? "SC-003: PASS" : "SC-003: FAIL");
  return s.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    },
  );
}
