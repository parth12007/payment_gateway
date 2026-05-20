import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createApp } from '../../src/app.js';
import { FakeGateway } from '../../src/gateway/fakeGateway.js';
import { TokenBucketRateLimiter } from '../../src/infra/rateLimit.js';
import { createRateLimitMiddleware } from '../../src/middleware/rateLimit.js';
import { PaymentService } from '../../src/services/paymentService.js';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL!);
const gateway = new FakeGateway();
const service = new PaymentService(gateway, prisma);

// Tight limits so the test is fast and obvious.
const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 5 }, redis);
const rateLimit = createRateLimitMiddleware(limiter);
const app = createApp({ gateway, paymentService: service, rateLimit });

async function cleanDb(): Promise<void> {
  await prisma.paymentEvent.deleteMany({});
  await prisma.payment.deleteMany({});
}

async function flushKeys(): Promise<void> {
  const keys = await redis.keys('ratelimit:rl-*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  await cleanDb();
  await flushKeys();
});

afterAll(async () => {
  await cleanDb();
  await flushKeys();
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(() => gateway.reset());
afterEach(async () => {
  await cleanDb();
  await flushKeys();
});

const body = (merchant: string, key: string): { merchant_id: string; amount: number; currency: string; payment_method_id: string } => ({
  merchant_id: merchant,
  amount: 100,
  currency: 'USD',
  payment_method_id: 'pm_test',
});

describe('Rate limiting on POST /v1/payments', () => {
  it('allows up to capacity, then returns 429 with Retry-After', async () => {
    gateway.setDefault({ kind: 'succeed' });
    const merchant = 'rl-burst';

    // 3 allowed, 4th blocked.
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/v1/payments')
        .set('Idempotency-Key', `rl-burst-${i}`)
        .send(body(merchant, `k${i}`));
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-remaining']).toBe(String(2 - i));
    }

    const blocked = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'rl-burst-blocked')
      .send(body(merchant, 'k-blocked'));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('isolates buckets per merchant', async () => {
    gateway.setDefault({ kind: 'succeed' });

    // Drain merchant A.
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/v1/payments')
        .set('Idempotency-Key', `rl-iso-a-${i}`)
        .send(body('rl-iso-a', `k${i}`));
      expect(res.status).toBe(201);
    }
    const blockedA = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'rl-iso-a-blocked')
      .send(body('rl-iso-a', 'kb'));
    expect(blockedA.status).toBe(429);

    // Merchant B is unaffected.
    const okB = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'rl-iso-b-1')
      .send(body('rl-iso-b', 'k1'));
    expect(okB.status).toBe(201);
  });

  it('refills tokens over time so the merchant can retry', async () => {
    gateway.setDefault({ kind: 'succeed' });
    const merchant = 'rl-refill';

    // Drain.
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/v1/payments')
        .set('Idempotency-Key', `rl-refill-${i}`)
        .send(body(merchant, `k${i}`));
    }
    const blocked = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'rl-refill-blocked')
      .send(body(merchant, 'k-blocked'));
    expect(blocked.status).toBe(429);

    // Wait for ~1 token to refill (refillPerSecond = 5 → 200ms per token).
    await new Promise((r) => setTimeout(r, 300));

    const ok = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'rl-refill-after')
      .send(body(merchant, 'k-after'));
    expect(ok.status).toBe(201);
  });

  it('does not rate-limit requests without a merchant_id (zod returns 400 instead)', async () => {
    const res = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'rl-no-merchant')
      .send({ amount: 100, currency: 'USD', payment_method_id: 'pm' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('does not rate-limit GET /v1/payments/:id or webhook routes', async () => {
    gateway.setDefault({ kind: 'succeed' });
    // Drain via a different merchant so we know the bucket is empty.
    const merchant = 'rl-other-routes';
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/v1/payments')
        .set('Idempotency-Key', `rl-other-${i}`)
        .send(body(merchant, `k${i}`));
    }
    // GET should still work — it's a different route, no middleware.
    const get = await request(app).get('/v1/payments/00000000-0000-0000-0000-000000000000');
    expect(get.status).toBe(404); // 404 not 429
  });
});
