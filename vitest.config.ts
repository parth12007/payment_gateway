import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/**/*.d.ts'],
    },
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10_000,
    // Integration tests share a single test DB. Run files sequentially to avoid
    // one file's afterEach(cleanDb) wiping another file's in-flight rows.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    env: {
      // Force the test DB URL — overrides anything Prisma reads from .env.
      DATABASE_URL: 'postgresql://payments:payments@localhost:5432/payments_test?schema=public',
      REDIS_URL: 'redis://localhost:6379/1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_fake_for_tests',
      STRIPE_SECRET_KEY: 'sk_test_fake_for_tests',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake_for_tests',
    },
  },
});
