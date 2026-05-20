import Stripe from 'stripe';
import { stripe as defaultStripeClient } from '../infra/stripe.js';
import type {
  ChargeRequest,
  ChargeResponse,
  PaymentGateway,
} from './gatewayPort.js';

export class StripeGateway implements PaymentGateway {
  constructor(private readonly client: Stripe = defaultStripeClient) {}

  async charge(req: ChargeRequest): Promise<ChargeResponse> {
    try {
      const intent = await this.client.paymentIntents.create(
        {
          amount: Number(req.amount),
          currency: req.currency.toLowerCase(),
          payment_method: req.paymentMethodId,
          confirm: true,
          ...(req.customerId ? { customer: req.customerId } : {}),
          ...(req.description ? { description: req.description } : {}),
          // Disable redirect-based methods so test cards behave synchronously.
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { internal_payment_id: req.paymentId },
        },
        { idempotencyKey: req.paymentId },
      );
      return mapIntent(intent);
    } catch (err) {
      return mapError(err);
    }
  }
}

function mapIntent(intent: Stripe.PaymentIntent): ChargeResponse {
  const ref = intent.id;
  switch (intent.status) {
    case 'succeeded':
      return { status: 'succeeded', gatewayReference: ref, raw: intent };
    case 'processing':
      return { status: 'processing', gatewayReference: ref, raw: intent };
    case 'requires_action':
    case 'requires_confirmation':
      return {
        status: 'requires_action',
        gatewayReference: ref,
        ...(intent.client_secret ? { clientSecret: intent.client_secret } : {}),
        raw: intent,
      };
    case 'canceled':
    case 'requires_payment_method':
      // Both are dead-end states; treat as permanent failure.
      return {
        status: 'failed',
        transient: false,
        errorCode: intent.last_payment_error?.code ?? 'payment_failed',
        errorMessage: intent.last_payment_error?.message ?? `PaymentIntent ${intent.status}`,
        gatewayReference: ref,
        raw: intent,
      };
    default:
      // Defensive: unknown future status — treat as transient so we retry.
      return {
        status: 'failed',
        transient: true,
        errorCode: 'unknown_status',
        errorMessage: `Unrecognized Stripe status: ${intent.status}`,
        gatewayReference: ref,
        raw: intent,
      };
  }
}

// Stripe error type → transient classification.
// See https://stripe.com/docs/api/errors/handling and
//     https://github.com/stripe/stripe-node#errors
export function classifyStripeError(err: unknown): {
  transient: boolean;
  code: string;
  message: string;
} {
  if (err instanceof Stripe.errors.StripeCardError) {
    return {
      transient: false,
      code: err.code ?? 'card_declined',
      message: err.message,
    };
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    return {
      transient: false,
      code: err.code ?? 'invalid_request',
      message: err.message,
    };
  }
  if (err instanceof Stripe.errors.StripeAuthenticationError) {
    return {
      transient: false,
      code: 'authentication_error',
      message: err.message,
    };
  }
  if (err instanceof Stripe.errors.StripePermissionError) {
    return {
      transient: false,
      code: 'permission_error',
      message: err.message,
    };
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return { transient: true, code: 'rate_limited', message: err.message };
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    return { transient: true, code: 'connection_error', message: err.message };
  }
  if (err instanceof Stripe.errors.StripeAPIError) {
    return { transient: true, code: 'api_error', message: err.message };
  }
  // Unknown — be conservative and treat as transient so a single weird error
  // doesn't permanently fail a payment, but max_attempts still caps the damage.
  const message = err instanceof Error ? err.message : String(err);
  return { transient: true, code: 'unknown_error', message };
}

function mapError(err: unknown): ChargeResponse {
  const { transient, code, message } = classifyStripeError(err);
  return { status: 'failed', transient, errorCode: code, errorMessage: message, raw: err };
}
