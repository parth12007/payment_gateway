// Exponential backoff with full jitter.
//   delay = min(base * 2^(attempt-1), maxDelay) + random(0, jitterMs)
// Attempt is 1-indexed (first retry uses attempt=1).

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Upper bound for the additive jitter. Defaults to 1000. */
  jitterMs?: number;
  /** Random source — injectable for deterministic tests. */
  random?: () => number;
}

export function computeBackoffMs(attempt: number, opts: BackoffOptions): number {
  if (attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`);
  const jitterCeil = opts.jitterMs ?? 1000;
  const random = opts.random ?? Math.random;

  // Cap exponent at 30 to avoid Number overflow for absurd attempt counts.
  const exp = Math.min(attempt - 1, 30);
  const raw = opts.baseMs * 2 ** exp;
  const capped = Math.min(raw, opts.maxMs);
  return Math.floor(capped + random() * jitterCeil);
}

export function nextRetryAt(now: Date, attempt: number, opts: BackoffOptions): Date {
  return new Date(now.getTime() + computeBackoffMs(attempt, opts));
}
