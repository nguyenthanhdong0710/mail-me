import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

const REDACT_PATHS = [
  "password",
  "pass",
  "apiKey",
  "botToken",
  "*.password",
  "*.pass",
  "*.apiKey",
  "*.botToken",
  "*.*.password",
];

/**
 * Structured JSON logger. Besides path-based redaction, every known secret value is
 * scrubbed from the final output, so a secret inside an error message never leaks.
 */
export function createLogger(
  opts: { level?: string; secrets?: string[] } = {},
  destination?: DestinationStream,
): Logger {
  const secrets = (opts.secrets ?? []).filter((s) => s.length >= 4);
  return pino(
    {
      level: opts.level ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      hooks: {
        streamWrite(s) {
          let out = s;
          for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
          return out;
        },
      },
    },
    destination,
  );
}
