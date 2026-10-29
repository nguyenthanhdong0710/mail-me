import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Grant, GrantStore } from "../domain/ports.js";

/** A grant file that exists but cannot be used. */
export class GrantFileError extends Error {
  override name = "GrantFileError";
}

/** Grant file name for a monitored account. */
export const readGrantName = (accountId: string) => `${accountId}.read`;
/** Grant file name for the email channel's sending account. */
export const SEND_GRANT_NAME = "email-channel.send";

/**
 * One JSON file per grant in `grants_dir` (research R5). Files are written atomically with
 * mode 0600 inside a 0700 directory, and a file readable by others is refused.
 */
export class FileGrantStore implements GrantStore {
  constructor(readonly dir: string) {}

  path(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  read(name: string): Grant | null {
    const path = this.path(name);
    let mode: number;
    try {
      mode = statSync(path).mode;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new GrantFileError(`cannot read ${path}: ${(err as Error).message}`);
    }
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new GrantFileError(
        `${path} can be read by other users. Run: chmod 600 ${path} ` +
          "(on a Windows drive such as /mnt/c permissions cannot be set; keep the grants folder on the Linux filesystem)",
      );
    }
    let grant: unknown;
    try {
      grant = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new GrantFileError(`${path} is not valid JSON: ${(err as Error).message}`);
    }
    if (!isGrant(grant)) {
      throw new GrantFileError(`${path} is not a Mail-Me grant file (or an unknown version)`);
    }
    return grant;
  }

  write(name: string, grant: Grant): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.path(name);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
}

function isGrant(value: unknown): value is Grant {
  const g = value as Partial<Grant> | null;
  return (
    !!g &&
    g.version === 1 &&
    (g.provider === "google" || g.provider === "microsoft") &&
    (g.purpose === "read" || g.purpose === "send") &&
    typeof g.address === "string" &&
    Array.isArray(g.scopes) &&
    typeof g.clientId === "string" &&
    typeof g.refreshToken === "string" &&
    g.refreshToken.length > 0
  );
}
