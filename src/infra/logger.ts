import pino from 'pino';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["stripe-signature"]',
  'req.headers["idempotency-key"]',
  '*.client_secret',
  '*.payment_method.card',
  '*.card.number',
  '*.card.cvc',
  '*.stripe_client_secret',
  'config.STRIPE_SECRET_KEY',
  'config.STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'payment-processing-system' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
        },
      }
    : {}),
});

export type Logger = typeof logger;
