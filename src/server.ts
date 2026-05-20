import 'dotenv/config';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { StripeGateway } from './gateway/stripeGateway.js';
import { disconnectDatabase } from './infra/db.js';
import { logger } from './infra/logger.js';
import { disconnectRedis } from './infra/redis.js';
import { PaymentService } from './services/paymentService.js';
import { RetryWorker } from './workers/retryWorker.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const gateway = new StripeGateway();
  const paymentService = new PaymentService(gateway);
  const app = createApp({ gateway, paymentService });

  const worker = new RetryWorker(paymentService, {
    intervalMs: env.RETRY_WORKER_INTERVAL_MS,
  });
  worker.start();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown initiated');
    await worker.stop().catch((err) => logger.error({ err }, 'worker stop failed'));
    server.close(() => logger.info('http server closed'));
    await disconnectDatabase().catch((err) => logger.error({ err }, 'db disconnect failed'));
    await disconnectRedis().catch((err) => logger.error({ err }, 'redis disconnect failed'));
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
