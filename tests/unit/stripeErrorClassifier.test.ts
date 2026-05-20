import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { classifyStripeError } from '../../src/gateway/stripeGateway.js';

// Stripe error class constructors vary across the SDK (some take raw error objects,
// some take strings, some are client-side only). For unit testing the classifier
// we only need objects that pass `instanceof` — Object.create on the prototype is
// the cleanest way to get one without invoking the actual constructor.
function fakeErr<T extends abstract new (...args: never[]) => Stripe.errors.StripeError>(
  Ctor: T,
  fields: { message: string; code?: string },
): Stripe.errors.StripeError {
  const e = Object.create(Ctor.prototype) as Stripe.errors.StripeError & {
    message: string;
    code?: string;
  };
  e.message = fields.message;
  if (fields.code) e.code = fields.code;
  return e;
}

describe('classifyStripeError', () => {
  it('card declines are NOT transient', () => {
    const err = fakeErr(Stripe.errors.StripeCardError, {
      message: 'declined',
      code: 'card_declined',
    });
    const r = classifyStripeError(err);
    expect(r.transient).toBe(false);
    expect(r.code).toBeTruthy();
  });

  it('invalid request errors are NOT transient', () => {
    const err = fakeErr(Stripe.errors.StripeInvalidRequestError, { message: 'bad param' });
    expect(classifyStripeError(err).transient).toBe(false);
  });

  it('authentication errors are NOT transient', () => {
    const err = fakeErr(Stripe.errors.StripeAuthenticationError, { message: 'bad key' });
    const r = classifyStripeError(err);
    expect(r.transient).toBe(false);
    expect(r.code).toBe('authentication_error');
  });

  it('rate limit errors ARE transient', () => {
    const err = fakeErr(Stripe.errors.StripeRateLimitError, { message: 'too many' });
    const r = classifyStripeError(err);
    expect(r.transient).toBe(true);
    expect(r.code).toBe('rate_limited');
  });

  it('connection errors ARE transient', () => {
    const err = fakeErr(Stripe.errors.StripeConnectionError, { message: 'econnreset' });
    const r = classifyStripeError(err);
    expect(r.transient).toBe(true);
    expect(r.code).toBe('connection_error');
  });

  it('generic API errors ARE transient', () => {
    const err = fakeErr(Stripe.errors.StripeAPIError, { message: '500 from stripe' });
    const r = classifyStripeError(err);
    expect(r.transient).toBe(true);
    expect(r.code).toBe('api_error');
  });

  it('unknown errors default to transient (conservative)', () => {
    const r = classifyStripeError(new Error('mystery'));
    expect(r.transient).toBe(true);
    expect(r.code).toBe('unknown_error');
    expect(r.message).toBe('mystery');
  });
});
