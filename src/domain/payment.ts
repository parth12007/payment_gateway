import { PaymentStatus } from '@prisma/client';
import { InvalidStateTransitionError } from './errors.js';

export { PaymentStatus };

export const TERMINAL_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILED,
]);

// Allowed transitions. The state machine is intentionally narrow — every other
// transition throws. Webhooks and worker code must go through `assertTransition`.
const ALLOWED: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  [PaymentStatus.PENDING]: new Set([
    PaymentStatus.PROCESSING,
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.PENDING, // re-queueing for retry after transient failure
  ]),
  [PaymentStatus.PROCESSING]: new Set([
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.PENDING, // back to pending for retry
  ]),
  [PaymentStatus.SUCCESS]: new Set(), // terminal
  [PaymentStatus.FAILED]: new Set(), // terminal
};

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED[from].has(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
