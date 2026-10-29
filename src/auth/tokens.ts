import {
  GrantRevokedError,
  type Clock,
  type GrantStore,
  type OAuthClient,
  type TokenProvider,
} from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { InvalidGrantError } from "./token-endpoint.js";

/** Refresh this long before the access token expires. */
const EARLY_REFRESH_MS = 60_000;

/**
 * Access tokens for one grant file (research R5). Tokens live in memory only; a rotated
 * refresh token is written back to the grant file. Concurrent callers share one refresh.
 */
export class GrantTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly ref: { name: string; fixCommand: string },
    private readonly store: GrantStore,
    private readonly client: OAuthClient,
    private readonly opts: { addSecret?: (value: string) => void; clock?: Clock } = {},
  ) {}

  accessToken(): Promise<string> {
    const now = (this.opts.clock ?? systemClock).now().getTime();
    if (this.cached && this.cached.expiresAt - now > EARLY_REFRESH_MS) {
      return Promise.resolve(this.cached.token);
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const { name, fixCommand } = this.ref;
    const grant = this.store.read(name);
    if (!grant) throw new GrantRevokedError(name, fixCommand, "grant file is missing");
    this.opts.addSecret?.(grant.refreshToken);

    let result;
    try {
      result = await this.client.refresh(grant);
    } catch (err) {
      if (err instanceof InvalidGrantError)
        throw new GrantRevokedError(name, fixCommand, err.message);
      throw err;
    }
    this.opts.addSecret?.(result.accessToken);
    if (result.refreshToken && result.refreshToken !== grant.refreshToken) {
      // Microsoft rotates refresh tokens; losing the new one would end the grant.
      this.opts.addSecret?.(result.refreshToken);
      this.store.write(name, {
        ...grant,
        refreshToken: result.refreshToken,
        updatedAt: (this.opts.clock ?? systemClock).now().toISOString(),
      });
    }
    this.cached = { token: result.accessToken, expiresAt: result.expiresAt.getTime() };
    return result.accessToken;
  }
}
