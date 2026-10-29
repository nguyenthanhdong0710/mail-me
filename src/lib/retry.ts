export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  factor?: number;
  /** Return false to stop retrying (the error is rethrown immediately). */
  shouldRetry?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter (research R6). */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  const factor = opts.factor ?? 2;
  const wait = opts.sleep ?? sleep;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || (opts.shouldRetry && !opts.shouldRetry(err))) break;
      const delay = baseMs * factor ** (attempt - 1);
      await wait(delay / 2 + random() * (delay / 2));
    }
  }
  throw lastError;
}

/** Bounds how many async tasks run at once (e.g. LLM calls). */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      // The releasing task hands its slot over directly, so `active` stays unchanged.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
