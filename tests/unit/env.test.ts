import { describe, expect, it, beforeEach } from 'vitest';
import { loadEnv, resetEnvForTests } from '../../src/config/env.js';

describe('env config', () => {
  beforeEach(() => resetEnvForTests());

  it('loads with valid env vars', () => {
    const env = loadEnv();
    expect(env.STRIPE_SECRET_KEY).toMatch(/^sk_/);
    expect(env.STRIPE_PUBLISHABLE_KEY).toMatch(/^pk_/);
    expect(env.STRIPE_WEBHOOK_SECRET).toMatch(/^whsec_/);
    expect(env.MAX_ATTEMPTS).toBe(3);
  });

  it('rejects a publishable key that does not start with pk_', () => {
    const original = process.env.STRIPE_PUBLISHABLE_KEY;
    process.env.STRIPE_PUBLISHABLE_KEY = 'oops_bad_prefix';
    expect(() => loadEnv()).toThrow(/STRIPE_PUBLISHABLE_KEY/);
    process.env.STRIPE_PUBLISHABLE_KEY = original;
  });

  it('rejects a secret key that does not start with sk_', () => {
    const original = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'pk_wrong_kind';
    expect(() => loadEnv()).toThrow(/STRIPE_SECRET_KEY/);
    process.env.STRIPE_SECRET_KEY = original;
  });
});
