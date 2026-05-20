import Stripe from 'stripe';
import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

const env = loadEnv();

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-02-24.acacia',
  timeout: env.STRIPE_API_TIMEOUT_MS,
  maxNetworkRetries: 0,
  telemetry: false,
  appInfo: {
    name: 'payment-processing-system',
    version: '0.1.0',
  },
});

export async function pingStripe(): Promise<boolean> {
  try {
    await stripe.balance.retrieve();
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'stripe ping failed');
    return false;
  }
}
