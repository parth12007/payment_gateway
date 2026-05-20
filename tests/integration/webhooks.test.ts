import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { FakeGateway } from '../../src/gateway/fakeGateway.js';
import { PaymentService } from '../../src/services/paymentService.js';
import { WebhookService } from '../../src/services/webhookService.js';

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';

const prisma = new PrismaClient();
const gateway = new FakeGateway();
const paymentService = new PaymentService(gateway, prisma);
// Explicit webhook secret so we don't depend on the env-loaded one.
const webhookService = new WebhookService(paymentService, undefined, prisma, WEBHOOK_SECRET);
const app = createApp({ gateway, paymentService, webhookService });

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

function signStripeEvent(payload: string, secret = WEBHOOK_SECRET, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signed = `${ts}.${payload}`;
  const sig = createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}

interface StripeEventOpts {
  id: string;
  type: string;
  paymentIntentId: string;
  extra?: Record<string, unknown>;
}

function buildEvent(opts: StripeEventOpts): string {
  return JSON.stringify({
    id: opts.id,
    object: 'event',
    type: opts.type,
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.paymentIntentId,
        object: 'payment_intent',
        status: opts.type.replace('payment_intent.', ''),
        ...opts.extra,
      },
    },
  });
}

async function createPaymentInProcessing(idempotencyKey: string): Promise<{ id: string; intentId: string }> {
  gateway.setDefault({ kind: 'processing' });
  const res = await request(app)
    .post('/v1/payments')
    .set('Idempotency-Key', idempotencyKey)
    .send({
      merchant_id: 'm-wh',
      amount: 999,
      currency: 'USD',
      payment_method_id: 'pm_test',
    });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PROCESSING');
  return { id: res.body.id as string, intentId: res.body.gateway_reference as string };
}

describe('POST /v1/webhooks/stripe', () => {
  it('rejects an invalid signature with 400', async () => {
    const payload = buildEvent({
      id: 'evt_invalid_1',
      type: 'payment_intent.succeeded',
      paymentIntentId: 'pi_does_not_matter',
    });
    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_signature');
    // Nothing persisted.
    const rows = await prisma.stripeWebhookDelivery.count();
    expect(rows).toBe(0);
  });

  it('applies a succeeded event and moves a PROCESSING payment to SUCCESS', async () => {
    const { id, intentId } = await createPaymentInProcessing('wh-success');
    const payload = buildEvent({
      id: 'evt_success_1',
      type: 'payment_intent.succeeded',
      paymentIntentId: intentId,
    });
    const sig = signStripeEvent(payload);
    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('applied');
    expect(res.body.payment_id).toBe(id);

    const row = await prisma.payment.findUnique({ where: { id } });
    expect(row?.status).toBe('SUCCESS');

    const delivery = await prisma.stripeWebhookDelivery.findUnique({
      where: { id: 'evt_success_1' },
    });
    expect(delivery?.processedAt).not.toBeNull();
    expect(delivery?.paymentId).toBe(id);
  });

  it('dedups duplicate deliveries of the same event id', async () => {
    const { id, intentId } = await createPaymentInProcessing('wh-dup');
    const payload = buildEvent({
      id: 'evt_dup_1',
      type: 'payment_intent.succeeded',
      paymentIntentId: intentId,
    });
    const sig = signStripeEvent(payload);

    const first = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('applied');

    // Resign with a fresh signature (Stripe replays use the same event id but
    // a fresh signature timestamp). Body — and so the event id — is unchanged.
    const sig2 = signStripeEvent(payload);
    const second = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', sig2)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate');

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId: id, type: 'WEBHOOK_RECEIVED' },
    });
    expect(events.length).toBe(1); // only first delivery applied
  });

  it('does NOT un-terminal a payment: a stale processing webhook after SUCCESS is ignored', async () => {
    const { id, intentId } = await createPaymentInProcessing('wh-terminal');
    // First, succeed via webhook.
    const okPayload = buildEvent({
      id: 'evt_term_succeed',
      type: 'payment_intent.succeeded',
      paymentIntentId: intentId,
    });
    await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeEvent(okPayload))
      .set('Content-Type', 'application/json')
      .send(okPayload);
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('SUCCESS');

    // Now a stale "processing" event arrives.
    const stale = buildEvent({
      id: 'evt_term_stale',
      type: 'payment_intent.processing',
      paymentIntentId: intentId,
    });
    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeEvent(stale))
      .set('Content-Type', 'application/json')
      .send(stale);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('applied'); // stored, but applied-as-noop on terminal

    const row = await prisma.payment.findUnique({ where: { id } });
    expect(row?.status).toBe('SUCCESS'); // unchanged

    // Audit trail: the ignored signal was logged as WEBHOOK_RECEIVED with ignored=true.
    const events = await prisma.paymentEvent.findMany({
      where: { paymentId: id, type: 'WEBHOOK_RECEIVED' },
      orderBy: { createdAt: 'asc' },
    });
    // 2 webhook events: the first one (applied) + the stale one (ignored).
    expect(events.length).toBe(2);
    const lastPayload = events[1]?.payload as { ignored?: boolean };
    expect(lastPayload.ignored).toBe(true);
  });

  it('buffers a webhook that arrives before a matching payment exists', async () => {
    const payload = buildEvent({
      id: 'evt_early_1',
      type: 'payment_intent.succeeded',
      paymentIntentId: 'pi_does_not_exist_yet',
    });
    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeEvent(payload))
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('buffered');
    const row = await prisma.stripeWebhookDelivery.findUnique({
      where: { id: 'evt_early_1' },
    });
    expect(row).not.toBeNull();
    expect(row?.paymentId).toBeNull();
  });

  it('stores unknown event types but does not apply them', async () => {
    const payload = buildEvent({
      id: 'evt_unknown_1',
      type: 'customer.subscription.updated',
      paymentIntentId: 'pi_irrelevant',
    });
    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeEvent(payload))
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toContain('unhandled_event_type');
  });
});
