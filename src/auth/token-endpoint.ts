import type { HttpFetch } from "../domain/ports.js";

/** The grant is no longer valid (revoked, expired, or the password changed). */
export class InvalidGrantError extends Error {
  override name = "InvalidGrantError";
}

/** The token endpoint could not be reached or failed; try again on the next poll. */
export class TokenEndpointError extends Error {
  override name = "TokenEndpointError";
}

/** Microsoft error codes that mean "sign in again" (research R5). */
const MS_REVOKED = /AADSTS(70008|50173|700082|700084|50078|50076|65001|7000222|500133)\b/;

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

/**
 * POSTs a form to an OAuth token endpoint. Error responses never include the request body, so
 * secrets in it cannot leak into messages.
 */
export async function postForm(
  fetch: HttpFetch,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: TokenResponse }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new TokenEndpointError(`token endpoint unreachable: ${(err as Error).message}`);
  }
  let body: TokenResponse;
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

/** Classifies a failed refresh: a dead grant, or a transient problem. */
export function refreshError(status: number, body: TokenResponse): Error {
  const detail = `${body.error ?? `HTTP ${status}`}${body.error_description ? `: ${firstLine(body.error_description)}` : ""}`;
  if (body.error === "invalid_grant" || MS_REVOKED.test(body.error_description ?? "")) {
    return new InvalidGrantError(detail);
  }
  if (status >= 500 || status === 429) return new TokenEndpointError(detail);
  // Other 4xx (e.g. invalid_client after the OAuth app was deleted) also need user action.
  return new InvalidGrantError(detail);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]!.slice(0, 200);
}

/** Parses an OAuth `scope` response field. */
export function splitScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}
