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
  "refreshToken",
  "accessToken",
  "clientSecret",
  "*.refreshToken",
  "*.accessToken",
  "*.clientSecret",
];

/**
 * Structured JSON logger. Besides path-based redaction, every known secret value is
 * scrubbed from the final output, so a secret inside an error message never leaks.
 * `secrets` may be a Set that grows later (OAuth tokens obtained at runtime); it is read on
 * every write.
 */
export function createLogger(
  opts: { level?: string; secrets?: Iterable<string> } = {},
  destination?: DestinationStream,
): Logger {
  const secrets = opts.secrets ?? [];
  return pino(
    {
      level: opts.level ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      hooks: {
        streamWrite(s) {
          let out = s;
          for (const secret of secrets) {
            if (secret.length >= 4) out = out.split(secret).join("[REDACTED]");
          }
          return out;
        },
      },
    },
    destination,
  );
}
