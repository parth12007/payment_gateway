import type { Redis } from 'ioredis';
import { redis as defaultRedis } from './redis.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left in the bucket after this request (0 when blocked). */
  remaining: number;
  /** Seconds the caller should wait before retrying. 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  /** Maximum tokens in the bucket. Defines the burst size. */
  capacity: number;
  /** Tokens added per second when the bucket isn't full. */
  refillPerSecond: number;
}

// Atomic token-bucket script. One Redis round-trip; no GET/SET race.
// KEYS[1]: bucket key
// ARGV[1]: capacity (max tokens)
// ARGV[2]: refill rate per ms
// ARGV[3]: now (ms since epoch)
// ARGV[4]: TTL for the key (seconds)
// Returns {allowed, remaining_tokens_x1000, retry_after_ms}
const LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl_sec = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  last_refill = now
else
  local elapsed = math.max(0, now - last_refill)
  tokens = math.min(capacity, tokens + elapsed * refill_per_ms)
  last_refill = now
end

if tokens < 1 then
  local deficit = 1 - tokens
  local retry_after_ms = math.ceil(deficit / refill_per_ms)
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
  redis.call('EXPIRE', key, ttl_sec)
  return {0, math.floor(tokens * 1000), retry_after_ms}
end

tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
redis.call('EXPIRE', key, ttl_sec)
return {1, math.floor(tokens * 1000), 0}
`;

export class TokenBucketRateLimiter {
  private readonly opts: RateLimitOptions;
  private readonly redisClient: Redis;
  private readonly ttlSeconds: number;

  constructor(opts: RateLimitOptions, redisClient: Redis = defaultRedis) {
    if (opts.capacity <= 0) throw new Error('capacity must be > 0');
    if (opts.refillPerSecond <= 0) throw new Error('refillPerSecond must be > 0');
    this.opts = opts;
    this.redisClient = redisClient;
    // TTL = double the time it would take to refill from empty, so idle keys
    // expire but the bucket state survives anything plausibly recent.
    this.ttlSeconds = Math.ceil((opts.capacity / opts.refillPerSecond) * 2);
  }

  /**
   * Attempt to consume 1 token from the bucket keyed by `identifier`.
   * Returns immediately — atomic in Redis.
   */
  async consume(identifier: string): Promise<RateLimitDecision> {
    const key = `ratelimit:${identifier}`;
    const refillPerMs = this.opts.refillPerSecond / 1000;
    const result = (await this.redisClient.eval(
      LUA_SCRIPT,
      1,
      key,
      String(this.opts.capacity),
      String(refillPerMs),
      String(Date.now()),
      String(this.ttlSeconds),
    )) as [number, number, number];

    const [allowed, remainingX1000, retryAfterMs] = result;
    return {
      allowed: allowed === 1,
      remaining: Math.floor(remainingX1000 / 1000),
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  }
}
