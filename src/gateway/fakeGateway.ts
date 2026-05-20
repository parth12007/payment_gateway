// Deterministic in-memory gateway for tests. Behaves like Stripe but never makes
// network calls. Behavior is set by registering scripted responses keyed by paymentId,
// or by a default outcome. Idempotency mimics Stripe: a repeat call with the same
// paymentId returns the same response without re-running the script.

import type {
  ChargeRequest,
  ChargeResponse,
  PaymentGateway,
} from './gatewayPort.js';

type Outcome =
  | { kind: 'succeed' }
  | { kind: 'processing' }
  | { kind: 'requires_action' }
  | { kind: 'decline'; code?: string; message?: string }
  | { kind: 'transient'; code?: string; message?: string }
  | { kind: 'throw'; error: Error };

export class FakeGateway implements PaymentGateway {
  private scripts = new Map<string, Outcome[]>();
  private cache = new Map<string, ChargeResponse>();
  public callLog: ChargeRequest[] = [];
  private defaultOutcome: Outcome = { kind: 'succeed' };

  setDefault(outcome: Outcome): void {
    this.defaultOutcome = outcome;
  }

  /** Push a scripted response. Pops one per `charge()` call for the given paymentId. */
  script(paymentId: string, ...outcomes: Outcome[]): void {
    const existing = this.scripts.get(paymentId) ?? [];
    existing.push(...outcomes);
    this.scripts.set(paymentId, existing);
  }

  reset(): void {
    this.scripts.clear();
    this.cache.clear();
    this.callLog = [];
    this.defaultOutcome = { kind: 'succeed' };
  }

  async charge(req: ChargeRequest): Promise<ChargeResponse> {
    this.callLog.push(req);

    // Idempotent replay — mirrors Stripe's idempotency-key behavior.
    const cached = this.cache.get(req.paymentId);
    if (cached) return cached;

    const queue = this.scripts.get(req.paymentId);
    const outcome = queue && queue.length > 0 ? queue.shift()! : this.defaultOutcome;

    if (outcome.kind === 'throw') {
      throw outcome.error;
    }

    const response = this.materialize(req, outcome);
    // Cache only non-failure outcomes. This mirrors the practical semantics of
    // retrying a failed charge: the caller re-attempts and the gateway makes a
    // fresh decision. Successful or in-flight responses are stable for replays
    // (matches Stripe's idempotency-key behavior).
    if (response.status !== 'failed') {
      this.cache.set(req.paymentId, response);
    }
    return response;
  }

  private materialize(req: ChargeRequest, outcome: Exclude<Outcome, { kind: 'throw' }>): ChargeResponse {
    const gatewayReference = `fake_${req.paymentId}`;
    switch (outcome.kind) {
      case 'succeed':
        return {
          status: 'succeeded',
          gatewayReference,
          raw: { id: gatewayReference, status: 'succeeded' },
        };
      case 'processing':
        return {
          status: 'processing',
          gatewayReference,
          raw: { id: gatewayReference, status: 'processing' },
        };
      case 'requires_action':
        return {
          status: 'requires_action',
          gatewayReference,
          clientSecret: `${gatewayReference}_secret`,
          raw: { id: gatewayReference, status: 'requires_action' },
        };
      case 'decline':
        return {
          status: 'failed',
          transient: false,
          errorCode: outcome.code ?? 'card_declined',
          errorMessage: outcome.message ?? 'Your card was declined.',
          gatewayReference,
          raw: { id: gatewayReference, status: 'failed' },
        };
      case 'transient':
        return {
          status: 'failed',
          transient: true,
          errorCode: outcome.code ?? 'api_error',
          errorMessage: outcome.message ?? 'Gateway transient error.',
          raw: { status: 'api_error' },
        };
    }
  }
}
