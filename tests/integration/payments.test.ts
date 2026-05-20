import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { FakeGateway } from '../../src/gateway/fakeGateway.js';
import { PaymentService } from '../../src/services/paymentService.js';

const prisma = new PrismaClient();
const gateway = new FakeGateway();
const service = new PaymentService(gateway, prisma);
const app = createApp({ gateway, paymentService: service });

const merchant = 'test-merchant-1';

async function cleanDb(): Promise<void> {
  await prisma.paymentEvent.deleteMany({});
  await prisma.payment.deleteMany({});
}

beforeAll(async () => {
  await cleanDb();
});

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

beforeEach(() => {
  gateway.reset();
});

afterEach(async () => {
  await cleanDb();
});

const validBody = {
  merchant_id: merchant,
  amount: 1000,
  currency: 'USD',
  payment_method_id: 'pm_test_visa',
};

describe('POST /v1/payments', () => {
  it('creates a payment and returns SUCCESS when the gateway succeeds', async () => {
    gateway.setDefault({ kind: 'succeed' });
    const res = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-success-1')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SUCCESS');
    expect(res.body.amount).toBe('1000');
    expect(res.body.currency).toBe('USD');
    expect(res.body.attempt_count).toBe(1);
    expect(res.body.gateway_reference).toMatch(/^fake_/);

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId: res.body.id },
      orderBy: { createdAt: 'asc' },
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('CREATED');
    expect(types).toContain('ATTEMPT_STARTED');
    expect(types).toContain('ATTEMPT_SUCCEEDED');
    expect(types).toContain('STATE_TRANSITIONED');
  });

  it('returns FAILED with no retry when the gateway declines the card', async () => {
    gateway.setDefault({ kind: 'decline', code: 'card_declined', message: 'No funds' });
    const res = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-decline-1')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.last_error_code).toBe('card_declined');
    expect(res.body.attempt_count).toBe(1);
  });

  it('re-queues to PENDING when the gateway has a transient failure', async () => {
    gateway.setDefault({ kind: 'transient', code: 'api_error', message: 'boom' });
    const res = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-transient-1')
      .send(validBody);

    expect(res.status).toBe(201);
    // Phase 1 stops here; Phase 2 worker will pick this up.
    expect(res.body.status).toBe('PENDING');
    expect(res.body.last_error_code).toBe('api_error');
  });

  it('returns PROCESSING when the gateway says requires_action (3DS)', async () => {
    gateway.setDefault({ kind: 'requires_action' });
    const res = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-3ds-1')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PROCESSING');
    expect(res.body.client_secret).toBeTruthy();
  });

  it('replays the same response for the same idempotency key + body', async () => {
    gateway.setDefault({ kind: 'succeed' });
    const first = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-replay-1')
      .send(validBody);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-replay-1')
      .send(validBody);
    expect(second.status).toBe(200); // 200 on replay (not 201)
    expect(second.body.id).toBe(first.body.id);
    expect(gateway.callLog.length).toBe(1); // gateway called only once
  });

  it('returns 409 when the same idempotency key is reused with a different body', async () => {
    gateway.setDefault({ kind: 'succeed' });
    const first = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-conflict-1')
      .send(validBody);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-conflict-1')
      .send({ ...validBody, amount: 2000 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_conflict');
  });

  it('rejects requests missing the Idempotency-Key header', async () => {
    const res = await request(app).post('/v1/payments').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  it('rejects invalid bodies via zod validation', async () => {
    const res = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-bad-1')
      .send({ merchant_id: 'm', amount: -1, currency: 'USDX', payment_method_id: 'pm' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('persists request body hash to detect future conflicts', async () => {
    gateway.setDefault({ kind: 'succeed' });
    const res = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-hash-1')
      .send(validBody);
    expect(res.status).toBe(201);
    const row = await prisma.payment.findUnique({ where: { id: res.body.id } });
    expect(row?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GET /v1/payments/:id', () => {
  it('returns the payment by id', async () => {
    gateway.setDefault({ kind: 'succeed' });
    const created = await request(app)
      .post('/v1/payments')
      .set('Idempotency-Key', 'k-get-1')
      .send(validBody);
    expect(created.status).toBe(201);

    const res = await request(app).get(`/v1/payments/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.status).toBe('SUCCESS');
  });

  it('returns 404 for a UUID that does not exist', async () => {
    const res = await request(app).get('/v1/payments/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 400 for a non-UUID id', async () => {
    const res = await request(app).get('/v1/payments/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
