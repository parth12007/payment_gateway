import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { TokenBucketRateLimiter } from '../../src/infra/rateLimit.js';

const redis = new Redis(process.env.REDIS_URL!);

async function flushTestKeys(): Promise<void> {
  const keys = await redis.keys('ratelimit:test-*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(flushTestKeys);
afterAll(async () => {
  await flushTestKeys();
  redis.disconnect();
});
beforeEach(flushTestKeys);

describe('TokenBucketRateLimiter', () => {
  it('allows up to capacity in a burst', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1 }, redis);
    const r1 = await limiter.consume('test-burst');
    const r2 = await limiter.consume('test-burst');
    const r3 = await limiter.consume('test-burst');
    const r4 = await limiter.consume('test-burst');

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('isolates buckets per identifier', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 1 }, redis);
    await limiter.consume('test-a');
    await limiter.consume('test-a');
    const aBlocked = await limiter.consume('test-a');
    const bAllowed = await limiter.consume('test-b');

    expect(aBlocked.allowed).toBe(false);
    expect(bAllowed.allowed).toBe(true);
  });

  it('refills over time', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 50 }, redis);
    const drain = await limiter.consume('test-refill');
    expect(drain.allowed).toBe(true);
    const blocked = await limiter.consume('test-refill');
    expect(blocked.allowed).toBe(false);

    // Wait long enough to refill ~2 tokens (capacity is 1, so it caps at 1).
    await new Promise((r) => setTimeout(r, 60));

    const after = await limiter.consume('test-refill');
    expect(after.allowed).toBe(true);
  });

  it('reports remaining tokens', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 0.01 }, redis);
    const r1 = await limiter.consume('test-remaining');
    expect(r1.remaining).toBe(2);
    const r2 = await limiter.consume('test-remaining');
    expect(r2.remaining).toBe(1);
    const r3 = await limiter.consume('test-remaining');
    expect(r3.remaining).toBe(0);
  });

  it('rejects invalid options at construction', () => {
    expect(
      () => new TokenBucketRateLimiter({ capacity: 0, refillPerSecond: 1 }, redis),
    ).toThrow();
    expect(
      () => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0 }, redis),
    ).toThrow();
  });
});
