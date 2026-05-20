import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '@prisma/client';
import {
  assertTransition,
  canTransition,
  isTerminal,
} from '../../src/domain/payment.js';
import { InvalidStateTransitionError } from '../../src/domain/errors.js';

describe('payment state machine', () => {
  it('PENDING -> PROCESSING allowed', () => {
    expect(canTransition(PaymentStatus.PENDING, PaymentStatus.PROCESSING)).toBe(true);
  });

  it('PROCESSING -> SUCCESS allowed', () => {
    expect(canTransition(PaymentStatus.PROCESSING, PaymentStatus.SUCCESS)).toBe(true);
  });

  it('PROCESSING -> FAILED allowed', () => {
    expect(canTransition(PaymentStatus.PROCESSING, PaymentStatus.FAILED)).toBe(true);
  });

  it('PROCESSING -> PENDING allowed (retry re-queue)', () => {
    expect(canTransition(PaymentStatus.PROCESSING, PaymentStatus.PENDING)).toBe(true);
  });

  it('SUCCESS is terminal — no outgoing transitions', () => {
    expect(canTransition(PaymentStatus.SUCCESS, PaymentStatus.PROCESSING)).toBe(false);
    expect(canTransition(PaymentStatus.SUCCESS, PaymentStatus.FAILED)).toBe(false);
    expect(canTransition(PaymentStatus.SUCCESS, PaymentStatus.PENDING)).toBe(false);
  });

  it('FAILED is terminal — no outgoing transitions', () => {
    expect(canTransition(PaymentStatus.FAILED, PaymentStatus.SUCCESS)).toBe(false);
    expect(canTransition(PaymentStatus.FAILED, PaymentStatus.PROCESSING)).toBe(false);
  });

  it('isTerminal returns true only for SUCCESS and FAILED', () => {
    expect(isTerminal(PaymentStatus.PENDING)).toBe(false);
    expect(isTerminal(PaymentStatus.PROCESSING)).toBe(false);
    expect(isTerminal(PaymentStatus.SUCCESS)).toBe(true);
    expect(isTerminal(PaymentStatus.FAILED)).toBe(true);
  });

  it('assertTransition throws InvalidStateTransitionError on forbidden moves', () => {
    expect(() => assertTransition(PaymentStatus.SUCCESS, PaymentStatus.PENDING)).toThrow(
      InvalidStateTransitionError,
    );
    expect(() => assertTransition(PaymentStatus.FAILED, PaymentStatus.SUCCESS)).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('assertTransition does not throw on allowed moves', () => {
    expect(() => assertTransition(PaymentStatus.PENDING, PaymentStatus.PROCESSING)).not.toThrow();
    expect(() => assertTransition(PaymentStatus.PROCESSING, PaymentStatus.SUCCESS)).not.toThrow();
  });
});
