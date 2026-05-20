import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../infra/logger.js';
import type { WebhookService } from '../services/webhookService.js';

export function createWebhooksRouter(service: WebhookService): Router {
  const router: Router = Router();

  // Raw body is required so we can verify Stripe's HMAC signature byte-for-byte.
  // Mounting express.raw only on this route prevents the global express.json
  // middleware from consuming the body first.
  router.post(
    '/v1/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const signature = req.header('stripe-signature');
        const result = await service.handle(req.body as Buffer, signature);

        switch (result.kind) {
          case 'invalid_signature':
            res.status(400).json({
              error: { code: 'invalid_signature', message: 'Invalid Stripe signature' },
            });
            return;
          case 'duplicate':
            res.status(200).json({ status: 'duplicate' });
            return;
          case 'ignored':
            res.status(200).json({ status: 'ignored', reason: result.reason });
            return;
          case 'buffered':
            res.status(202).json({ status: 'buffered', event_id: result.eventId });
            return;
          case 'applied':
            res
              .status(200)
              .json({ status: 'applied', event_id: result.eventId, payment_id: result.paymentId });
            return;
        }
      } catch (err) {
        logger.error(
          { err: (err as Error).message, requestId: req.requestId },
          'webhook handler threw',
        );
        next(err);
      }
    },
  );

  return router;
}
