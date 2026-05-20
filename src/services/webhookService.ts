import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { loadEnv } from '../config/env.js';
import { prisma as defaultPrisma } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { stripe as defaultStripeClient } from '../infra/stripe.js';
import type { ExternalSignal, PaymentService } from './paymentService.js';

export type WebhookResult =
  | { kind: 'invalid_signature' }
  | { kind: 'duplicate' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'buffered'; eventId: string; reason: 'no_matching_payment' }
  | { kind: 'applied'; eventId: string; paymentId: string };

export class WebhookService {
  private readonly webhookSecret: string;

  constructor(
    private readonly service: PaymentService,
    private readonly stripeClient: Stripe = defaultStripeClient,
    private readonly db = defaultPrisma,
    webhookSecret?: string,
  ) {
    this.webhookSecret = webhookSecret ?? loadEnv().STRIPE_WEBHOOK_SECRET;
  }

  /**
   * Verify and process a single Stripe webhook delivery.
   *  - Invalid signature → result is `invalid_signature`. Caller returns 400.
   *  - Duplicate (we've seen this event id before) → returns `duplicate`. Caller returns 200.
   *  - Recognized event but no matching payment → stored as `buffered` for later
   *    reconciliation. Caller returns 200 so Stripe doesn't retry.
   *  - Recognized event for a payment → applied; caller returns 200.
   */
  async handle(rawBody: Buffer, signatureHeader: string | undefined): Promise<WebhookResult> {
    if (!signatureHeader) return { kind: 'invalid_signature' };

    let event: Stripe.Event;
    try {
      event = this.stripeClient.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        this.webhookSecret,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'stripe webhook signature verification failed',
      );
      return { kind: 'invalid_signature' };
    }

    // Insert delivery record. The unique PK (Stripe event id) gives us free dedup.
    try {
      await this.db.stripeWebhookDelivery.create({
        data: {
          id: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
          signatureValid: true,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        logger.info({ eventId: event.id, type: event.type }, 'duplicate webhook ignored');
        return { kind: 'duplicate' };
      }
      throw err;
    }

    const signal = toSignal(event);
    if (!signal) {
      await this.markProcessed(event.id, null);
      return { kind: 'ignored', reason: `unhandled_event_type:${event.type}` };
    }

    const payment = await this.service.findByGatewayReference(signal.gatewayReference);
    if (!payment) {
      // Early callback: webhook arrived before our paymentIntent.create response
      // committed (or before we even attempted). Leave the delivery row with
      // payment_id = null. The retry worker / a reconcile pass can revisit.
      logger.info(
        { eventId: event.id, gatewayReference: signal.gatewayReference },
        'webhook received with no matching payment; buffering',
      );
      return { kind: 'buffered', eventId: event.id, reason: 'no_matching_payment' };
    }

    await this.service.applyExternalSignal(payment.id, signal);
    await this.markProcessed(event.id, payment.id);
    return { kind: 'applied', eventId: event.id, paymentId: payment.id };
  }

  private async markProcessed(eventId: string, paymentId: string | null): Promise<void> {
    await this.db.stripeWebhookDelivery.update({
      where: { id: eventId },
      data: {
        processedAt: new Date(),
        ...(paymentId ? { paymentId } : {}),
      },
    });
  }
}

/**
 * Map a Stripe event to our internal ExternalSignal type. Returns undefined for
 * events we don't act on (we still store the delivery for traceability).
 */
function toSignal(event: Stripe.Event): (ExternalSignal & { gatewayReference: string }) | undefined {
  const intent = (event.data.object as Stripe.PaymentIntent) ?? null;
  if (!intent || !intent.id) return undefined;
  const gatewayReference = intent.id;
  switch (event.type) {
    case 'payment_intent.succeeded':
      return { kind: 'succeeded', gatewayReference };
    case 'payment_intent.payment_failed':
      return {
        kind: 'failed',
        gatewayReference,
        errorCode: intent.last_payment_error?.code ?? 'payment_failed',
        errorMessage: intent.last_payment_error?.message ?? 'Payment failed',
      };
    case 'payment_intent.canceled':
      return {
        kind: 'failed',
        gatewayReference,
        errorCode: 'canceled',
        errorMessage: 'PaymentIntent was canceled',
      };
    case 'payment_intent.processing':
      return { kind: 'processing', gatewayReference };
    default:
      return undefined;
  }
}
