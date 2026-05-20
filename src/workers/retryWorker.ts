import type { Payment } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import type { PaymentService } from '../services/paymentService.js';

export interface RetryWorkerOptions {
  intervalMs: number;
  batchSize?: number;
}

/**
 * Picks up PENDING payments whose next_retry_at has elapsed and runs them
 * through the payment service. Uses SELECT … FOR UPDATE SKIP LOCKED so multiple
 * workers can run safely in parallel.
 *
 * The worker is a polling loop in Phase 2. Phase 3 swaps in BullMQ.
 */
export class RetryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  /** Resolves when an in-flight tick has finished (used by stop()). */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: PaymentService,
    private readonly opts: RetryWorkerOptions,
    private readonly db = defaultPrisma,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    logger.info({ intervalMs: this.opts.intervalMs }, 'retry worker started');
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    this.running = false;
    logger.info('retry worker stopped');
  }

  /**
   * Run a single tick. Exposed so tests can drive the worker deterministically
   * without waiting for the polling timer.
   */
  async tick(): Promise<number> {
    const batchSize = this.opts.batchSize ?? 10;
    // Step 1: under a short tx, claim a batch via row locks.
    // The query returns the locked rows; SKIP LOCKED means another worker
    // running the same query gets a disjoint set.
    const claimed = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`
          SELECT id FROM payments
          WHERE status = 'PENDING'
            AND (next_retry_at IS NULL OR next_retry_at <= now())
          ORDER BY created_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `,
      );
      return rows.map((r) => r.id);
    });

    if (claimed.length === 0) return 0;

    // Step 2: process each claim outside the tx (Stripe calls take real time).
    // We re-fetch the row to get the full Payment object, then run processPending,
    // which uses version-checked updates so any concurrent writer is caught.
    let processed = 0;
    for (const id of claimed) {
      const payment = await this.db.payment.findUnique({ where: { id } });
      if (!payment) continue;
      // Defensive: if a webhook flipped it to a terminal state between the lock
      // release and now, skip.
      if (payment.status !== 'PENDING') continue;
      try {
        await this.service.processPending(payment as Payment);
        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ paymentId: id, err: message }, 'retry worker: processPending failed');
      }
    }
    return processed;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.runOnce().finally(() => this.schedule());
    }, this.opts.intervalMs);
  }

  private async runOnce(): Promise<void> {
    try {
      const n = await this.tick();
      if (n > 0) logger.debug({ processed: n }, 'retry worker tick');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'retry worker tick threw');
    }
  }
}
