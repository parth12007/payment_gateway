// Test env defaults. Tests run with fake secrets so env validation passes.
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'error';
process.env.DATABASE_URL ??= 'postgresql://payments:payments@localhost:5432/payments_test?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.STRIPE_PUBLISHABLE_KEY ??= 'pk_test_fake_for_tests';
process.env.STRIPE_SECRET_KEY ??= 'sk_test_fake_for_tests';
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_fake_for_tests';
