import { GrantRevokedError, type HttpFetch, type TokenProvider } from "../domain/ports.js";

/** A failed provider API call. `transient` errors are retried on the next poll. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly transient: boolean,
    readonly retryAfterMs?: number,
    /** Provider error code, e.g. Graph `ErrorAccessDenied`. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface ApiRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Authorized calls to Gmail API / Microsoft Graph (002 research R1). On 401 the access token is
 * dropped and the call retried once; a second 401 means the grant is no longer usable. Error
 * messages never contain tokens.
 */
export class ApiClient {
  constructor(
    private readonly fetch: HttpFetch,
    private readonly tokens: TokenProvider,
    private readonly revoked: { name: string; fixCommand: string },
    private readonly label: string,
  ) {}

  async request(url: string, req: ApiRequest = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.accessToken();
      let res: Response;
      try {
        res = await this.fetch(url, {
          method: req.method ?? "GET",
          headers: { ...req.headers, authorization: `Bearer ${token}` },
          ...(req.body !== undefined && { body: req.body }),
        });
      } catch (err) {
        throw new ApiError(`${this.label}: network error: ${(err as Error).message}`, 0, true);
      }
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      if (res.ok) return res;
      throw await this.error(res);
    }
  }

  async json<T>(url: string, req: ApiRequest = {}): Promise<T> {
    return (await (await this.request(url, req)).json()) as T;
  }

  private async error(res: Response): Promise<Error> {
    let code: string | undefined;
    let message = res.statusText;
    try {
      const body = (await res.json()) as {
        error?: { code?: string | number; message?: string; status?: string } | string;
      };
      if (typeof body.error === "object" && body.error) {
        code = String(body.error.status ?? body.error.code ?? "");
        message = body.error.message ?? message;
      } else if (typeof body.error === "string") {
        code = body.error;
      }
    } catch {
      // not JSON
    }
    const text = `${this.label}: HTTP ${res.status}${code ? ` ${code}` : ""}: ${message}`.slice(
      0,
      300,
    );
    if (res.status === 401) {
      return new GrantRevokedError(this.revoked.name, this.revoked.fixCommand, `HTTP 401`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    return new ApiError(
      text,
      res.status,
      res.status === 429 || res.status >= 500,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      code,
    );
  }
}
