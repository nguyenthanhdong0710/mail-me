import type { HttpFetch } from "../../src/domain/ports.js";

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export type RouteReply =
  { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | Error;
type Handler = (call: RecordedCall) => RouteReply;

/**
 * Route-based fake for REST APIs (Gmail, Graph, OAuth token endpoints). Routes match on method
 * and a regex over `host + pathname`; the first matching route answers. Unmatched calls are 404.
 */
export class FakeApi {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  private onceCount = 0;

  on(method: string, pattern: RegExp, reply: RouteReply | Handler): this {
    const handler = typeof reply === "function" ? reply : () => reply;
    this.routes.push({ method, pattern, handler });
    return this;
  }

  /** Answers the next matching call with `reply`, then falls through to later routes. */
  once(method: string, pattern: RegExp, reply: RouteReply): this {
    let used = false;
    // One-off replies answer in the order they were queued, before any regular route.
    this.routes.splice(this.onceCount++, 0, {
      method,
      pattern,
      handler: (call) => {
        if (used) return NEXT;
        used = true;
        void call;
        return reply;
      },
    });
    return this;
  }

  callsTo(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => pattern.test(c.url.host + c.url.pathname));
  }

  fetch: HttpFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers,
      body: typeof init.body === "string" ? init.body : "",
    };
    this.calls.push(call);
    for (const route of this.routes) {
      if (route.method !== call.method) continue;
      if (!route.pattern.test(call.url.host + call.url.pathname)) continue;
      const reply = route.handler(call);
      if (reply === NEXT) continue;
      if (reply instanceof Error) throw reply;
      const body = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
      return new Response(body === "" && reply.status === 204 ? null : body, {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    }
    return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
  };
}

const NEXT = { status: -1 } as const;
