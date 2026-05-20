import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/infra/db.js', () => ({
  pingDatabase: vi.fn(),
  disconnectDatabase: vi.fn(),
  prisma: {},
}));
vi.mock('../../src/infra/redis.js', () => ({
  pingRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  redis: {},
}));
vi.mock('../../src/infra/stripe.js', () => ({
  pingStripe: vi.fn(),
  stripe: {},
}));

const { pingDatabase } = await import('../../src/infra/db.js');
const { pingRedis } = await import('../../src/infra/redis.js');
const { pingStripe } = await import('../../src/infra/stripe.js');
const { createApp } = await import('../../src/app.js');

describe('GET /healthz', () => {
  it('returns 200 ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('sets an x-request-id header', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes back an inbound x-request-id', async () => {
    const res = await request(createApp()).get('/healthz').set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

describe('GET /readyz', () => {
  beforeEach(() => {
    vi.mocked(pingDatabase).mockReset();
    vi.mocked(pingRedis).mockReset();
    vi.mocked(pingStripe).mockReset();
  });

  it('returns 200 when all dependencies are healthy', async () => {
    vi.mocked(pingDatabase).mockResolvedValue(true);
    vi.mocked(pingRedis).mockResolvedValue(true);
    vi.mocked(pingStripe).mockResolvedValue(true);
    const res = await request(createApp()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks).toEqual({ database: true, redis: true, stripe: true });
  });

  it('returns 503 when any dependency is unhealthy', async () => {
    vi.mocked(pingDatabase).mockResolvedValue(true);
    vi.mocked(pingRedis).mockResolvedValue(false);
    vi.mocked(pingStripe).mockResolvedValue(true);
    const res = await request(createApp()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis).toBe(false);
  });
});

describe('unknown route', () => {
  it('returns 404 with structured error envelope', async () => {
    const res = await request(createApp()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.request_id).toBeTruthy();
  });
});
