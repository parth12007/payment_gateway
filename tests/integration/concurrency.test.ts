import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { FakeGateway } from '../../src/gateway/fakeGateway.js';
import { PaymentService } from '../../src/services/paymentService.js';

const prisma = new PrismaClient();
const gateway = new FakeGateway();
const service = new PaymentService(gateway, prisma);
const app = createApp({ gateway, paymentService: service });

async function cleanDb(): Promise<void> {
  await prisma.paymentEvent.deleteMany({});
  await prisma.payment.deleteMany({});
}

beforeAll(cleanDb);
afterEach(cleanDb);
afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe('concurrency: parallel POSTs with the same Idempotency-Key', () => {
  it('produces exactly one Payment row and one gateway call', async () => {
    gateway.reset();
    gateway.setDefault({ kind: 'succeed' });

    const body = {
      merchant_id: 'concurrent-merchant',
      amount: 5000,
      currency: 'USD',
      payment_method_id: 'pm_test_visa',
    };
    const key = 'k-parallel-1';
    const N = 10;

    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app).post('/v1/payments').set('Idempotency-Key', key).send(body),
      ),
    );

    // All requests should succeed (either 201 for the winner or 200 for replays).
    for (const r of responses) {
      expect([200, 201]).toContain(r.status);
    }
    const statuses = responses.map((r) => r.status).sort();
    // Exactly one creator (201), the rest replays (200).
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 200).length).toBe(N - 1);

    // All responses point to the same payment id.
    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);

    // Exactly one row in the DB.
    const rows = await prisma.payment.findMany({
      where: { merchantId: body.merchant_id, idempotencyKey: key },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('SUCCESS');

    // Gateway was called exactly once — duplicate requests must not hit Stripe.
    expect(gateway.callLog.length).toBe(1);
  });

  it('rejects with 409 if a parallel request uses the same key with a different body', async () => {
    gateway.reset();
    gateway.setDefault({ kind: 'succeed' });

    const key = 'k-parallel-conflict';
    const bodyA = {
      merchant_id: 'm-conflict',
      amount: 100,
      currency: 'USD',
      payment_method_id: 'pm_a',
    };
    const bodyB = { ...bodyA, amount: 200 };

    const [resA, resB] = await Promise.all([
      request(app).post('/v1/payments').set('Idempotency-Key', key).send(bodyA),
      request(app).post('/v1/payments').set('Idempotency-Key', key).send(bodyB),
    ]);

    // One must succeed (200 or 201), the other must conflict.
    const codes = [resA.status, resB.status].sort();
    expect(codes).toContain(409);
    // The non-conflict response is the winner.
    const winner = resA.status === 409 ? resB : resA;
    expect([200, 201]).toContain(winner.status);

    const rows = await prisma.payment.findMany({
      where: { merchantId: bodyA.merchant_id, idempotencyKey: key },
    });
    expect(rows.length).toBe(1);
  });
});
