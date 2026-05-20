import { Prisma, type Payment, PaymentEventType, PaymentStatus } from '@prisma/client';
import { loadEnv } from '../config/env.js';
import { prisma as defaultPrisma } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { IdempotencyConflictError, PaymentNotFoundError } from '../domain/errors.js';
import { assertTransition, isTerminal } from '../domain/payment.js';
import type { ChargeResponse, PaymentGateway } from '../gateway/gatewayPort.js';
import { requestHash } from '../utils/canonicalJson.js';
import { computeBackoffMs } from '../utils/backoff.js';

export interface CreatePaymentInput {
  merchantId: string;
  idempotencyKey: string;
  amount: bigint;
  currency: string;
  paymentMethodId: string;
  customerId?: string;
  description?: string;
}

export interface CreatePaymentResult {
  payment: Payment;
  /** True when an existing payment was returned instead of creating + charging a new one. */
  replayed: boolean;
}

interface TransitionOpts {
  type: PaymentEventType;
  payload: Prisma.InputJsonValue;
  attemptDelta?: number;
  gatewayReference?: string;
  errorCode?: string;
  errorMessage?: string;
  nextRetryAt?: Date;
  clearNextRetry?: boolean;
  extraEvents?: { type: PaymentEventType; payload: Prisma.InputJsonValue }[];
}

export type ExternalSignal =
  | { kind: 'succeeded'; gatewayReference: string; detail?: Prisma.InputJsonValue }
  | {
      kind: 'failed';
      gatewayReference?: string;
      errorCode: string;
      errorMessage: string;
      detail?: Prisma.InputJsonValue;
    }
  | { kind: 'processing'; gatewayReference: string; detail?: Prisma.InputJsonValue };

export class PaymentService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly db = defaultPrisma,
  ) {}

  async create(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const hash = requestHash({
      merchantId: input.merchantId,
      amount: input.amount.toString(),
      currency: input.currency,
      paymentMethodId: input.paymentMethodId,
      customerId: input.customerId ?? null,
      description: input.description ?? null,
    });

    const existing = await this.db.payment.findUnique({
      where: {
        payment_merchant_idempotency_unique: {
          merchantId: input.merchantId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== hash) throw new IdempotencyConflictError();
      return { payment: existing, replayed: true };
    }

    let created: Payment;
    try {
      created = await this.db.payment.create({
        data: {
          merchantId: input.merchantId,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          amount: input.amount,
          currency: input.currency.toUpperCase(),
          paymentMethodId: input.paymentMethodId,
          ...(input.customerId ? { customerId: input.customerId } : {}),
          ...(input.description ? { description: input.description } : {}),
          status: PaymentStatus.PENDING,
          events: {
            create: {
              type: PaymentEventType.CREATED,
              payload: {
                paymentMethodId: input.paymentMethodId,
                ...(input.customerId ? { customerId: input.customerId } : {}),
              },
            },
          },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const other = await this.db.payment.findUnique({
          where: {
            payment_merchant_idempotency_unique: {
              merchantId: input.merchantId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (!other) throw err;
        if (other.requestHash !== hash) throw new IdempotencyConflictError();
        return { payment: other, replayed: true };
      }
      throw err;
    }

    // First attempt happens synchronously on the create request, so successful
    // payments return 201 with their final state immediately. A transient
    // failure leaves the row in PENDING with next_retry_at set, and the
    // retry worker takes over.
    const charged = await this.attempt(created);
    return { payment: charged, replayed: false };
  }

  async get(id: string): Promise<Payment> {
    const payment = await this.db.payment.findUnique({ where: { id } });
    if (!payment) throw new PaymentNotFoundError(id);
    return payment;
  }

  async findByGatewayReference(ref: string): Promise<Payment | null> {
    return this.db.payment.findUnique({ where: { stripePaymentIntentId: ref } });
  }

  /**
   * Apply an external signal (typically from a provider webhook) to a payment.
   * Terminal payments are never moved; non-terminal payments transition per the
   * standard state machine. The whole apply happens inside a row lock so it
   * serializes with the retry worker.
   */
  async applyExternalSignal(
    paymentId: string,
    signal: ExternalSignal,
  ): Promise<Payment | null> {
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`,
      );
      if (locked.length === 0) return null;
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return null;

      if (isTerminal(payment.status)) {
        logger.info(
          { paymentId, status: payment.status, signal: signal.kind },
          'webhook signal received for terminal payment; ignoring',
        );
        await tx.paymentEvent.create({
          data: {
            paymentId,
            type: PaymentEventType.WEBHOOK_RECEIVED,
            payload: {
              ignored: true,
              reason: 'terminal_state',
              currentStatus: payment.status,
              signal: signal.kind,
            },
          },
        });
        return payment;
      }

      await tx.paymentEvent.create({
        data: {
          paymentId,
          type: PaymentEventType.WEBHOOK_RECEIVED,
          payload: {
            signal: signal.kind,
            ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
          },
        },
      });

      // The transition itself runs through the standard helper, but inside this
      // outer transaction. We call the inner `applyTransitionInTx` so it joins
      // our tx instead of opening its own.
      switch (signal.kind) {
        case 'succeeded':
          return this.applyTransitionInTx(tx, payment, PaymentStatus.SUCCESS, {
            type: PaymentEventType.ATTEMPT_SUCCEEDED,
            payload: { gatewayReference: signal.gatewayReference, source: 'webhook' },
            gatewayReference: signal.gatewayReference,
            clearNextRetry: true,
          });
        case 'failed':
          return this.applyTransitionInTx(tx, payment, PaymentStatus.FAILED, {
            type: PaymentEventType.ATTEMPT_FAILED_PERMANENT,
            payload: {
              errorCode: signal.errorCode,
              errorMessage: signal.errorMessage,
              source: 'webhook',
            },
            errorCode: signal.errorCode,
            errorMessage: signal.errorMessage,
            ...(signal.gatewayReference
              ? { gatewayReference: signal.gatewayReference }
              : {}),
            clearNextRetry: true,
          });
        case 'processing':
          // If we're already in PROCESSING, just refresh the gateway ref.
          if (payment.status === PaymentStatus.PROCESSING) {
            return tx.payment.update({
              where: { id: payment.id, version: payment.version },
              data: {
                version: { increment: 1 },
                stripePaymentIntentId: signal.gatewayReference,
              },
            });
          }
          return this.applyTransitionInTx(tx, payment, PaymentStatus.PROCESSING, {
            type: PaymentEventType.STATE_TRANSITIONED,
            payload: { source: 'webhook' },
            gatewayReference: signal.gatewayReference,
          });
      }
    });
  }

  /**
   * Run one charge attempt for a payment currently in PENDING.
   * Used by both the create path (synchronous first attempt) and the retry worker.
   * Caller must ensure exclusive access — for the worker, that means a row lock.
   */
  async processPending(payment: Payment): Promise<Payment> {
    if (payment.status !== PaymentStatus.PENDING) {
      logger.warn(
        { paymentId: payment.id, status: payment.status },
        'processPending called on non-PENDING payment; skipping',
      );
      return payment;
    }
    return this.attempt(payment);
  }

  private async attempt(payment: Payment): Promise<Payment> {
    const current = await this.transition(payment, PaymentStatus.PROCESSING, {
      type: PaymentEventType.ATTEMPT_STARTED,
      payload: { attempt: payment.attemptCount + 1 },
      attemptDelta: 1,
    });

    let response: ChargeResponse;
    try {
      response = await this.gateway.charge({
        paymentId: current.id,
        amount: current.amount,
        currency: current.currency,
        paymentMethodId: current.paymentMethodId,
        ...(current.customerId ? { customerId: current.customerId } : {}),
        ...(current.description ? { description: current.description } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ paymentId: current.id, err: message }, 'gateway threw unexpectedly');
      response = {
        status: 'failed',
        transient: true,
        errorCode: 'gateway_threw',
        errorMessage: message,
        raw: { error: message },
      };
    }
    return this.applyChargeResponse(current, response);
  }

  private async applyChargeResponse(
    payment: Payment,
    response: ChargeResponse,
  ): Promise<Payment> {
    switch (response.status) {
      case 'succeeded':
        return this.transition(payment, PaymentStatus.SUCCESS, {
          type: PaymentEventType.ATTEMPT_SUCCEEDED,
          payload: { gatewayReference: response.gatewayReference },
          gatewayReference: response.gatewayReference,
          clearNextRetry: true,
        });
      case 'processing':
      case 'requires_action':
        return this.updateGatewayRef(payment, {
          gatewayReference: response.gatewayReference,
          ...('clientSecret' in response && response.clientSecret
            ? { clientSecret: response.clientSecret }
            : {}),
        });
      case 'failed': {
        if (response.transient && payment.attemptCount < payment.maxAttempts) {
          const env = loadEnv();
          const delayMs = computeBackoffMs(payment.attemptCount, {
            baseMs: env.BACKOFF_BASE_MS,
            maxMs: env.BACKOFF_MAX_MS,
          });
          const next = new Date(Date.now() + delayMs);
          logger.info(
            {
              paymentId: payment.id,
              attempt: payment.attemptCount,
              maxAttempts: payment.maxAttempts,
              nextRetryAt: next.toISOString(),
              delayMs,
            },
            'scheduling retry after transient failure',
          );
          return this.transition(payment, PaymentStatus.PENDING, {
            type: PaymentEventType.ATTEMPT_FAILED_TRANSIENT,
            payload: {
              errorCode: response.errorCode,
              errorMessage: response.errorMessage,
              attempt: payment.attemptCount,
              nextRetryAt: next.toISOString(),
            },
            errorCode: response.errorCode,
            errorMessage: response.errorMessage,
            nextRetryAt: next,
            extraEvents: [{ type: PaymentEventType.RETRY_SCHEDULED, payload: { delayMs } }],
          });
        }
        return this.transition(payment, PaymentStatus.FAILED, {
          type: response.transient
            ? PaymentEventType.ATTEMPT_FAILED_TRANSIENT
            : PaymentEventType.ATTEMPT_FAILED_PERMANENT,
          payload: {
            errorCode: response.errorCode,
            errorMessage: response.errorMessage,
            transient: response.transient,
            retryBudgetExhausted: response.transient,
          },
          errorCode: response.errorCode,
          errorMessage: response.errorMessage,
          ...(response.gatewayReference
            ? { gatewayReference: response.gatewayReference }
            : {}),
          clearNextRetry: true,
        });
      }
    }
  }

  private async transition(
    payment: Payment,
    nextStatus: PaymentStatus,
    opts: TransitionOpts,
  ): Promise<Payment> {
    return this.db.$transaction((tx) =>
      this.applyTransitionInTx(tx, payment, nextStatus, opts),
    );
  }

  private async applyTransitionInTx(
    tx: Prisma.TransactionClient,
    payment: Payment,
    nextStatus: PaymentStatus,
    opts: TransitionOpts,
  ): Promise<Payment> {
    if (isTerminal(payment.status)) {
      logger.warn(
        { paymentId: payment.id, from: payment.status, to: nextStatus },
        'attempted transition from terminal state; ignoring',
      );
      return payment;
    }
    assertTransition(payment.status, nextStatus);

    const updated = await tx.payment.update({
      where: { id: payment.id, version: payment.version },
      data: {
        status: nextStatus,
        version: { increment: 1 },
        ...(opts.attemptDelta ? { attemptCount: { increment: opts.attemptDelta } } : {}),
        ...(opts.gatewayReference ? { stripePaymentIntentId: opts.gatewayReference } : {}),
        ...(opts.errorCode !== undefined ? { lastErrorCode: opts.errorCode } : {}),
        ...(opts.errorMessage !== undefined ? { lastErrorMessage: opts.errorMessage } : {}),
        ...(opts.nextRetryAt ? { nextRetryAt: opts.nextRetryAt } : {}),
        ...(opts.clearNextRetry ? { nextRetryAt: null } : {}),
      },
    });
    await tx.paymentEvent.create({
      data: { paymentId: payment.id, type: opts.type, payload: opts.payload },
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: payment.id,
        type: PaymentEventType.STATE_TRANSITIONED,
        payload: { from: payment.status, to: nextStatus },
      },
    });
    for (const evt of opts.extraEvents ?? []) {
      await tx.paymentEvent.create({
        data: { paymentId: payment.id, type: evt.type, payload: evt.payload },
      });
    }
    logger.info(
      {
        paymentId: payment.id,
        from: payment.status,
        to: nextStatus,
        attempt: updated.attemptCount,
      },
      'payment state transitioned',
    );
    return updated;
  }

  private async updateGatewayRef(
    payment: Payment,
    fields: { gatewayReference: string; clientSecret?: string },
  ): Promise<Payment> {
    return this.db.payment.update({
      where: { id: payment.id, version: payment.version },
      data: {
        version: { increment: 1 },
        stripePaymentIntentId: fields.gatewayReference,
        ...(fields.clientSecret ? { stripeClientSecret: fields.clientSecret } : {}),
      },
    });
  }
}
