import express, { type Express, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { loadEnv } from './config/env.js';
import { logger } from './infra/logger.js';
import { TokenBucketRateLimiter } from './infra/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { healthRouter } from './routes/health.js';
import { createPaymentsRouter } from './routes/payments.js';
import { createWebhooksRouter } from './routes/webhooks.js';
import { PaymentService } from './services/paymentService.js';
import { WebhookService } from './services/webhookService.js';
import { StripeGateway } from './gateway/stripeGateway.js';
import type { PaymentGateway } from './gateway/gatewayPort.js';

export interface AppDeps {
  /** Override the gateway (tests use FakeGateway). Defaults to StripeGateway. */
  gateway?: PaymentGateway;
  /** Override the payment service entirely. Mainly for tests. */
  paymentService?: PaymentService;
  /** Override the webhook service. Mainly for tests. */
  webhookService?: WebhookService;
  /**
   * Override the rate-limit middleware. When omitted, defaults to the env-configured
   * per-merchant token bucket. Pass `null` to disable rate limiting entirely.
   */
  rateLimit?: RequestHandler | null;
}

export function createApp(deps: AppDeps = {}): Express {
  const env = loadEnv();
  const gateway = deps.gateway ?? new StripeGateway();
  const paymentService = deps.paymentService ?? new PaymentService(gateway);
  const webhookService = deps.webhookService ?? new WebhookService(paymentService);

  // null = explicitly disabled. undefined = use the default env-configured limiter
  //   (unless the env var also disables it). A truthy value = caller-supplied.
  let rateLimit: RequestHandler | undefined;
  if (deps.rateLimit === null) {
    rateLimit = undefined;
  } else if (deps.rateLimit) {
    rateLimit = deps.rateLimit;
  } else if (env.RATE_LIMIT_ENABLED) {
    const limiter = new TokenBucketRateLimiter({
      capacity: env.RATE_LIMIT_CAPACITY,
      refillPerSecond: env.RATE_LIMIT_REFILL_PER_SECOND,
    });
    rateLimit = createRateLimitMiddleware(limiter);
  }

  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ requestId: (req as express.Request).requestId }),
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Webhook router MUST come before express.json so its express.raw middleware
  // can read the body untouched for HMAC verification.
  app.use(createWebhooksRouter(webhookService));

  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);
  app.use(
    createPaymentsRouter({
      service: paymentService,
      ...(rateLimit ? { rateLimit } : {}),
    }),
  );

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: `Route not found: ${req.method} ${req.path}`,
        request_id: req.requestId,
      },
    });
  });

  app.use(errorHandler);

  return app;
}
