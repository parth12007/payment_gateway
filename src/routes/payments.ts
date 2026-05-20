import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
  type NextFunction,
} from 'express';
import type { Payment } from '@prisma/client';
import { z } from 'zod';
import {
  DomainError,
  IdempotencyConflictError,
  PaymentNotFoundError,
} from '../domain/errors.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { PaymentService } from '../services/paymentService.js';

const createBodySchema = z.object({
  merchant_id: z.string().min(1).max(128),
  amount: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  currency: z
    .string()
    .length(3)
    .transform((s) => s.toUpperCase()),
  payment_method_id: z.string().min(1),
  customer_id: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
});

export interface PaymentsRouterDeps {
  service: PaymentService;
  /** Optional rate-limit middleware. When omitted, the route has no limiter. */
  rateLimit?: RequestHandler;
}

export function createPaymentsRouter(
  arg: PaymentService | PaymentsRouterDeps,
): Router {
  const deps: PaymentsRouterDeps =
    'service' in arg ? arg : { service: arg };
  const service = deps.service;
  const router: Router = Router();

  const createHandler: RequestHandler = async (req, res, next) => {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey || idempotencyKey.length === 0 || idempotencyKey.length > 255) {
        throw new HttpError(400, 'invalid_request', 'Idempotency-Key header is required (1-255 chars)');
      }
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_request',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const body = parsed.data;
      const { payment, replayed } = await service.create({
        merchantId: body.merchant_id,
        idempotencyKey,
        amount: BigInt(body.amount),
        currency: body.currency,
        paymentMethodId: body.payment_method_id,
        ...(body.customer_id ? { customerId: body.customer_id } : {}),
        ...(body.description ? { description: body.description } : {}),
      });
      res.status(replayed ? 200 : 201).json(serializePayment(payment));
    } catch (err) {
      next(translate(err));
    }
  };

  if (deps.rateLimit) {
    router.post('/v1/payments', deps.rateLimit, createHandler);
  } else {
    router.post('/v1/payments', createHandler);
  }

  router.get('/v1/payments/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!id || !isUuid(id)) {
        throw new HttpError(400, 'invalid_request', 'id must be a UUID');
      }
      const payment = await service.get(id);
      res.status(200).json(serializePayment(payment));
    } catch (err) {
      next(translate(err));
    }
  });

  return router;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function translate(err: unknown): unknown {
  if (err instanceof IdempotencyConflictError) {
    return new HttpError(409, err.code, err.message);
  }
  if (err instanceof PaymentNotFoundError) {
    return new HttpError(404, err.code, err.message);
  }
  if (err instanceof DomainError) {
    return new HttpError(400, err.code, err.message);
  }
  return err;
}

function serializePayment(p: Payment): Record<string, unknown> {
  return {
    id: p.id,
    merchant_id: p.merchantId,
    idempotency_key: p.idempotencyKey,
    amount: p.amount.toString(),
    currency: p.currency,
    status: p.status,
    attempt_count: p.attemptCount,
    max_attempts: p.maxAttempts,
    next_retry_at: p.nextRetryAt?.toISOString() ?? null,
    gateway_reference: p.stripePaymentIntentId,
    client_secret: p.stripeClientSecret,
    last_error_code: p.lastErrorCode,
    last_error_message: p.lastErrorMessage,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
