import { Router } from 'express';
import { pingDatabase } from '../infra/db.js';
import { pingRedis } from '../infra/redis.js';
import { pingStripe } from '../infra/stripe.js';

export const healthRouter: Router = Router();

healthRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

healthRouter.get('/readyz', async (_req, res) => {
  const [db, redis, stripe] = await Promise.all([pingDatabase(), pingRedis(), pingStripe()]);
  const ready = db && redis && stripe;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    checks: { database: db, redis, stripe },
  });
});
