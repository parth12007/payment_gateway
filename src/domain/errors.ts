// Domain-level errors. Mapped to HTTP responses by the route layer.

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message = 'Idempotency-Key reused with a different request body') {
    super('idempotency_conflict', message);
    this.name = 'IdempotencyConflictError';
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super('invalid_state_transition', `Cannot transition payment from ${from} to ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class PaymentNotFoundError extends DomainError {
  constructor(id: string) {
    super('not_found', `Payment not found: ${id}`);
    this.name = 'PaymentNotFoundError';
  }
}

export class GatewayError extends DomainError {
  constructor(
    public transient: boolean,
    public underlyingCode: string,
    message: string,
  ) {
    super('gateway_error', message);
    this.name = 'GatewayError';
  }
}
