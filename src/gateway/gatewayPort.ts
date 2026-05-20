// The provider-agnostic interface our application code talks to.
// StripeGateway (real) and FakeGateway (tests) both implement this.

export interface ChargeRequest {
  /** Our internal payment id. Used as the gateway-side idempotency key. */
  paymentId: string;
  amount: bigint;
  currency: string;
  paymentMethodId: string;
  customerId?: string;
  description?: string;
}

export type ChargeOutcome = 'succeeded' | 'processing' | 'requires_action' | 'failed';

export interface ChargeSuccess {
  status: Exclude<ChargeOutcome, 'failed'>;
  gatewayReference: string;
  clientSecret?: string;
  raw: unknown;
}

export interface ChargeFailure {
  status: 'failed';
  transient: boolean;
  errorCode: string;
  errorMessage: string;
  /** Set only when the gateway gave us a reference before failing. */
  gatewayReference?: string;
  raw: unknown;
}

export type ChargeResponse = ChargeSuccess | ChargeFailure;

export interface PaymentGateway {
  charge(req: ChargeRequest): Promise<ChargeResponse>;
}
