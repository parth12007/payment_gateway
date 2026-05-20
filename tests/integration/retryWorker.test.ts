import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { FakeGateway } from '../../src/gateway/fakeGateway.js';
import { PaymentService } from '../../src/services/paymentService.js';
import { RetryWorker } from '../../src/workers/retryWorker.js';

const prisma = new PrismaClient();
const gateway = new FakeGateway();
const service = new PaymentService(gateway, prisma);
const app = createApp({ gateway, paymentService: service });

async function cleanDb(): Promise<void> {
  await prisma.paymentEvent.deleteMany({});
  await prisma.stripeWebhookDelivery.deleteMany({});
  await prisma.payment.deleteMany({});
}

beforeAll(cleanDb);
afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});
beforeEach(() => gateway.reset());
afterEach(cleanDb);

const body = {
  merchant_id: 'm-retry',
  amount: 500,
  currency: 'USD',
  payment_method_id: 'pm_test_visa',
};

async function makePending(idempotencyKey: string): Promise<string> {
  // Force a transient failure on the first attempt — leaves the row in PENDING.
  gateway.setDefault({ kind: 'transient', code: 'api_error' });
  const res = await request(app)
    .post('/v1/payments')
    .set('Idempotency-Key', idempotencyKey)
    .send(body);
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  return res.body.id;
}

/**
 * Move the payment's next_retry_at into the past so the worker considers it due.
 * Avoids waiting on real backoff timers in tests.
 */
async function makeDue(id: string): Promise<void> {
  await prisma.payment.update({
    where: { id },
    data: { nextRetryAt: new Date(Date.now() - 60_000) },
  });
}

describe('RetryWorker', () => {
  it('picks up a due PENDING payment and processes it to SUCCESS on retry success', async () => {
    const id = await makePending('k-retry-success');
    await makeDue(id);

    // Second attempt: succeed.
    gateway.setDefault({ kind: 'succeed' });
    const worker = new RetryWorker(service, { intervalMs: 1000 }, prisma);
    const n = await worker.tick();
    expect(n).toBe(1);

    const after = await prisma.payment.findUnique({ where: { id } });
    expect(after?.status).toBe('SUCCESS');
    expect(after?.attemptCount).toBe(2);
  });

  it('escalates to FAILED once max_attempts is reached on repeated transients', async () => {
    const id = await makePending('k-retry-exhaust');
    // Keep failing transiently.
    gateway.setDefault({ kind: 'transient', code: 'api_error' });
    const worker = new RetryWorker(service, { intervalMs: 1000 }, prisma);

    // attempt 2 (still under cap of 3) → back to PENDING
    await makeDue(id);
    await worker.tick();
    let row = await prisma.payment.findUnique({ where: { id } });
    expect(row?.status).toBe('PENDING');
    expect(row?.attemptCount).toBe(2);

    // attempt 3 → cap reached → FAILED
    await makeDue(id);
    await worker.tick();
    row = await prisma.payment.findUnique({ where: { id } });
    expect(row?.status).toBe('FAILED');
    expect(row?.attemptCount).toBe(3);
    expect(row?.lastErrorCode).toBe('api_error');
  });

  it('does not pick up a PENDING payment whose next_retry_at is in the future', async () => {
    const id = await makePending('k-retry-not-due');
    await prisma.payment.update({
      where: { id },
      data: { nextRetryAt: new Date(Date.now() + 60_000) },
    });

    const worker = new RetryWorker(service, { intervalMs: 1000 }, prisma);
    const n = await worker.tick();
    expect(n).toBe(0);

    const after = await prisma.payment.findUnique({ where: { id } });
    expect(after?.status).toBe('PENDING'); // unchanged
  });

  it('two workers racing the same row produce exactly one new attempt', async () => {
    const id = await makePending('k-retry-race');
    await makeDue(id);
    gateway.setDefault({ kind: 'succeed' });

    const w1 = new RetryWorker(service, { intervalMs: 1000 }, prisma);
    const w2 = new RetryWorker(service, { intervalMs: 1000 }, prisma);
    const [n1, n2] = await Promise.all([w1.tick(), w2.tick()]);

    // Exactly one worker picks up the row.
    expect(n1 + n2).toBe(1);

    const after = await prisma.payment.findUnique({ where: { id } });
    expect(after?.status).toBe('SUCCESS');
    expect(after?.attemptCount).toBe(2);

    // Gateway was called exactly twice total (initial attempt + one retry).
    expect(gateway.callLog.length).toBe(2);
  });
});
