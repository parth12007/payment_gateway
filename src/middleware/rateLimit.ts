import type { NextFunction, Request, Response } from 'express';
import { logger } from '../infra/logger.js';
import type { TokenBucketRateLimiter } from '../infra/rateLimit.js';

/**
 * Per-merchant rate-limit middleware.
 *
 * Reads `merchant_id` from the JSON body (already parsed by express.json) and
 * consumes one token from that merchant's bucket. On exhaustion returns 429
 * with a Retry-After header.
 *
 * If `merchant_id` is missing or invalid, the middleware does NOT block — the
 * downstream zod validator will produce a 400. This keeps "bad input" and
 * "rate limited" responses unambiguous.
 */
export function createRateLimitMiddleware(limiter: TokenBucketRateLimiter) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = req.body as { merchant_id?: unknown } | undefined;
    const merchantId =
      body && typeof body.merchant_id === 'string' && body.merchant_id.length > 0
        ? body.merchant_id
        : null;
    if (!merchantId) {
      next();
      return;
    }

    try {
      const decision = await limiter.consume(merchantId);
      // Set informational headers on every response (allowed or not) for clients.
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        logger.warn(
          {
            merchantId,
            retryAfterSeconds: decision.retryAfterSeconds,
            requestId: req.requestId,
          },
          'rate limit exceeded',
        );
        res.status(429).json({
          error: {
            code: 'rate_limited',
            message: `Too many requests. Retry after ${decision.retryAfterSeconds}s.`,
            request_id: req.requestId,
          },
        });
        return;
      }
      next();
    } catch (err) {
      // Fail-open: if Redis is down, we'd rather process the payment than reject it.
      // Production would alert on these errors and consider a different policy.
      logger.error(
        { err: (err as Error).message, merchantId, requestId: req.requestId },
        'rate limiter errored; allowing request',
      );
      next();
    }
  };
}
