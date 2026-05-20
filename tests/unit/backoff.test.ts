import { describe, expect, it } from 'vitest';
import { computeBackoffMs, nextRetryAt } from '../../src/utils/backoff.js';

const opts = { baseMs: 1000, maxMs: 60_000, jitterMs: 1000, random: () => 0 };

describe('computeBackoffMs', () => {
  it('returns base + 0 jitter on attempt 1 with zero random', () => {
    expect(computeBackoffMs(1, opts)).toBe(1000);
  });

  it('doubles on each successive attempt', () => {
    expect(computeBackoffMs(1, opts)).toBe(1000);
    expect(computeBackoffMs(2, opts)).toBe(2000);
    expect(computeBackoffMs(3, opts)).toBe(4000);
    expect(computeBackoffMs(4, opts)).toBe(8000);
  });

  it('caps at maxMs', () => {
    // 2^9 * 1000 = 512_000, capped to 60_000.
    expect(computeBackoffMs(10, opts)).toBe(60_000);
    expect(computeBackoffMs(20, opts)).toBe(60_000);
  });

  it('adds jitter from the injected random source', () => {
    const delay = computeBackoffMs(1, { ...opts, random: () => 0.5 });
    // 1000 base + floor(500) jitter
    expect(delay).toBe(1500);
  });

  it('does not exceed maxMs + jitter', () => {
    const delay = computeBackoffMs(100, { ...opts, random: () => 0.999 });
    expect(delay).toBeLessThanOrEqual(60_000 + 1000);
  });

  it('throws on invalid attempt < 1', () => {
    expect(() => computeBackoffMs(0, opts)).toThrow();
    expect(() => computeBackoffMs(-3, opts)).toThrow();
  });
});

describe('nextRetryAt', () => {
  it('adds the computed backoff to now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const result = nextRetryAt(now, 2, opts);
    expect(result.getTime() - now.getTime()).toBe(2000);
  });
});
