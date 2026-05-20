-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentEventType" AS ENUM ('CREATED', 'ATTEMPT_STARTED', 'ATTEMPT_SUCCEEDED', 'ATTEMPT_FAILED_TRANSIENT', 'ATTEMPT_FAILED_PERMANENT', 'WEBHOOK_RECEIVED', 'STATE_TRANSITIONED', 'RETRY_SCHEDULED');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "next_retry_at" TIMESTAMPTZ(6),
    "stripe_payment_intent_id" TEXT,
    "stripe_client_secret" TEXT,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "type" "PaymentEventType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payment_id" UUID,
    "payload" JSONB NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "stripe_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripe_payment_intent_id_key" ON "payments"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "payments_status_next_retry_at_idx" ON "payments"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_merchant_id_idempotency_key_key" ON "payments"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payment_events_payment_id_created_at_idx" ON "payment_events"("payment_id", "created_at");

-- CreateIndex
CREATE INDEX "stripe_webhook_deliveries_payment_id_idx" ON "stripe_webhook_deliveries"("payment_id");

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
