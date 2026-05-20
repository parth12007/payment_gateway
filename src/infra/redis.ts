import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

const env = loadEnv();

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  enableReadyCheck: true,
});

redis.on('error', (err) => logger.error({ err }, 'redis error'));
redis.on('connect', () => logger.info('redis connected'));

export async function pingRedis(): Promise<boolean> {
  try {
    const res = await redis.ping();
    return res === 'PONG';
  } catch (err) {
    logger.error({ err }, 'redis ping failed');
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  redis.disconnect();
}
