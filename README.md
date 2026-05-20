# Payment Processing System

A payment processing service backed by **Stripe** that demonstrates retry, idempotency, concurrency, and webhook handling.

> Status: retry worker + Stripe webhooks complete.

---

## Stack

- Node.js 20+ / TypeScript
- Express
- PostgreSQL + Prisma
- Redis
- Stripe SDK (`stripe`)
- Vitest + Supertest

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env` with **your own** Stripe test-mode keys from the [Stripe dashboard](https://dashboard.stripe.com/test/apikeys).

> **Security:** never commit `.env`, never paste secret keys (`sk_test_…`, `whsec_…`) into chat or screenshots. If a secret leaks, **rotate it immediately** in the Stripe dashboard (Developers → API keys → Roll key).

### 3. Start Postgres + Redis

If Docker is installed:

```bash
docker compose up -d
```

Otherwise, run Postgres + Redis natively and adjust `DATABASE_URL` / `REDIS_URL` in `.env`.

### 4. Generate the Prisma client

```bash
npm run prisma:generate
```

### 5. Run

```bash
npm run dev     # tsx watch mode
# or
npm run build && npm start
```

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness — always 200 if the process is up. |
| GET | `/readyz` | Readiness — pings Postgres, Redis, Stripe. 200 if all up, 503 otherwise. |
| POST | `/v1/payments` | Create a payment. Requires `Idempotency-Key` header. |
| GET | `/v1/payments/:id` | Read the current state of a payment. |
| POST | `/v1/webhooks/stripe` | Receive Stripe webhook events. Requires `Stripe-Signature` header. |

### Try it

```bash
# Health checks
curl -i http://localhost:3000/healthz
curl -i http://localhost:3000/readyz

# Create a payment with a Stripe test card (success)
curl -i -X POST http://localhost:3000/v1/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-$(date +%s)" \
  -d '{
    "merchant_id": "demo-merchant",
    "amount": 1500,
    "currency": "USD",
    "payment_method_id": "pm_card_visa"
  }'

# Create a payment that gets declined (no retry — permanent failure)
curl -i -X POST http://localhost:3000/v1/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: decline-$(date +%s)" \
  -d '{
    "merchant_id": "demo-merchant",
    "amount": 2000,
    "currency": "USD",
    "payment_method_id": "pm_card_chargeDeclined"
  }'

# Read a payment
curl -i http://localhost:3000/v1/payments/<id>
```

### Idempotency

- Send the **same** `Idempotency-Key` with the **same body** → returns `200` (replay) with the original payment, **no second Stripe call**.
- Send the **same** `Idempotency-Key` with a **different body** → returns `409 idempotency_conflict`.
- Enforced via a `UNIQUE(merchant_id, idempotency_key)` constraint in Postgres, and propagated to Stripe via the `idempotencyKey` option on every `paymentIntents.create` call (so retries from our side never double-charge).

### Stripe test cards (test mode)

| Card | Outcome |
|---|---|
| `pm_card_visa` | SUCCESS |
| `pm_card_chargeDeclined` | FAILED (no retry — card declined is permanent) |
| `pm_card_chargeDeclinedInsufficientFunds` | FAILED with specific decline reason |
| `pm_card_authenticationRequired` | PROCESSING (3DS — client must confirm) |

### Retry behavior

Transient failures (5xx, network errors, rate limits) are retried with exponential backoff + jitter, up to `MAX_ATTEMPTS` (default 3).

- The first attempt runs synchronously on `POST /v1/payments`. A success or permanent failure returns immediately.
- A transient failure leaves the row in `PENDING` with `next_retry_at` set (e.g. `now + 1s`, then `+2s`, `+4s`, …).
- A background **retry worker** polls every `RETRY_WORKER_INTERVAL_MS` (default 2s) for PENDING rows whose `next_retry_at` has elapsed. It locks each row with `SELECT … FOR UPDATE SKIP LOCKED`, so multiple workers running in parallel can never double-process the same row.
- The worker uses `paymentService.processPending()`, which goes through the same state-machine + version-checked update as the create path.
- Once `attempt_count` reaches `max_attempts`, the next transient failure terminally FAILS the row.
- **Card declines never consume retry budget** — they're permanent failures that go straight to FAILED.

### Webhook handling

`POST /v1/webhooks/stripe` accepts events from Stripe.

- **Signature**: verified with `stripe.webhooks.constructEvent` using the raw body and `STRIPE_WEBHOOK_SECRET`. Invalid signatures return `400 invalid_signature` with no DB write.
- **Dedup**: every event is persisted by Stripe event id (`evt_…`) in `stripe_webhook_deliveries`. The unique PK constraint drops replays — returning `200 duplicate`.
- **Apply**: known events (`payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.canceled`) are mapped to internal signals and applied inside a row-locked transaction.
- **Terminal-state safety**: a webhook arriving for a payment already in `SUCCESS` or `FAILED` is recorded in the audit log but **never** un-terminals the state. Stripe's terminal state is authoritative only while we are non-terminal.
- **Early callbacks**: a webhook whose `payment_intent.id` doesn't yet match any of our rows returns `202 buffered`. The delivery row is stored with `payment_id = null` for a future reconcile pass.

### Rate limiting

`POST /v1/payments` is rate-limited **per merchant** via a Redis-backed token bucket.

- Default: **20-token burst, 10 tokens/sec refill** per `merchant_id`.
- On exhaustion, the API returns `429 rate_limited` with a `Retry-After` header (in seconds).
- Every response carries an `X-RateLimit-Remaining` header so clients can self-throttle.
- The bucket is keyed only by `merchant_id` — other merchants are unaffected.
- Webhooks (`POST /v1/webhooks/stripe`) and reads (`GET /v1/payments/:id`) are **not** rate-limited.
- The atomic check-and-decrement runs as a single Redis Lua script — no race between concurrent requests.
- Fail-open: if Redis is down, requests are allowed through (we log loudly).

Tune via env vars:

```
RATE_LIMIT_ENABLED=1                # 0 to disable entirely
RATE_LIMIT_CAPACITY=20              # burst size
RATE_LIMIT_REFILL_PER_SECOND=10     # steady-state rate
```

### Local webhook forwarding

To receive real Stripe events on `localhost` during development, use the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```bash
# In one terminal: forward live test events to your local server
stripe listen --forward-to localhost:3000/v1/webhooks/stripe

# Copy the printed `whsec_…` into your .env as STRIPE_WEBHOOK_SECRET, then restart the server.

# In another terminal: trigger a fake event
stripe trigger payment_intent.succeeded
```

---

## Testing

Tests run against a **separate** database (`payments_test`) so they can wipe rows between runs without touching your dev data. Postgres credentials are reused from `docker-compose.yml` (`payments` / `payments`); only the DB name differs.

### One-time setup

With the Postgres container already running (`docker compose up -d`):

**Step 1 — create the empty test database.** `prisma migrate deploy` will *not* create the database for you (it's the production-safe command and assumes the DB exists), so create it manually first:

```bash
docker exec pps_postgres psql -U payments -d payments \
  -c "CREATE DATABASE payments_test;"
```

If you're not using Docker, run the same SQL against your local Postgres:

```bash
psql -U payments -d payments -c "CREATE DATABASE payments_test;"
```

**Step 2 — apply migrations to it:**

```bash
DATABASE_URL="postgresql://payments:payments@localhost:5432/payments_test?schema=public" \
  npx prisma migrate deploy
```

Re-run step 2 any time you add a new migration. Step 1 is one-time only.

> Why not `prisma migrate dev`? It *would* auto-create the database and apply migrations in one shot, but it also generates new migration files on schema drift and prompts for input — not what you want for a throwaway test DB. `migrate deploy` is unattended and CI-safe.

### Run the suite

```bash
npm test          # one-shot
npm run test:watch
```

`vitest.config.ts` pins the test `DATABASE_URL` (and Redis DB index `1`, plus fake Stripe keys) inline, so `npm test` works without editing your `.env`. If you change Postgres credentials, update both [vitest.config.ts](vitest.config.ts) and [tests/setup.ts](tests/setup.ts) to match.

### Reset the test DB

If migrations get out of sync or you want a clean slate:

```bash
DATABASE_URL="postgresql://payments:payments@localhost:5432/payments_test?schema=public" \
  npx prisma migrate reset --force
```

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start in watch mode with `tsx`. |
| `npm run build` | TypeScript build to `dist/`. |
| `npm start` | Run compiled output. |
| `npm run typecheck` | TypeScript without emit. |
| `npm test` | Run vitest once. |
| `npm run test:watch` | Vitest watch mode. |
| `npm run lint` | ESLint. |
| `npm run format` | Prettier write. |
| `npm run prisma:generate` | Regenerate Prisma client. |
| `npm run prisma:migrate` | Apply migrations (use after Phase 1 lands real models). |
| `npm run prisma:studio` | Browse the DB. |

---

## Project Layout

```
src/
  app.ts                  # Express app factory
  server.ts               # Bootstrap, signal handling
  config/env.ts           # zod-validated env
  infra/                  # logger, db, redis, stripe
  middleware/             # requestId, errorHandler
  routes/                 # health (more to come)
prisma/                   # schema + migrations
tests/
  setup.ts                # test env defaults
  unit/                   # pure-function tests
  integration/            # HTTP tests with supertest
docker-compose.yml        # Postgres + Redis
doc/                      # assignment + implementation plan
```