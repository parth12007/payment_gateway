import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  STRIPE_PUBLISHABLE_KEY: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('pk_'), 'STRIPE_PUBLISHABLE_KEY must start with pk_'),
  STRIPE_SECRET_KEY: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('sk_'), 'STRIPE_SECRET_KEY must start with sk_'),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('whsec_'), 'STRIPE_WEBHOOK_SECRET must start with whsec_'),
  STRIPE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  RETRY_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

  RATE_LIMIT_ENABLED: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().positive().default(10),

  RUN_LIVE: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvForTests(): void {
  cached = null;
}
