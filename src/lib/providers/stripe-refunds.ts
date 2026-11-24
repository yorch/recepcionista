/**
 * Stripe Refunds (deposit payments) over fetch, with timeouts. Separate from stripe.ts (payment links) and stripe-billing.ts.
 *
 * API: POST /v1/refunds {payment_intent, amount (cents), reason, metadata[...]} with an `Idempotency-Key` header; the answer is a Refund
 * {id, status: pending | requires_action | succeeded | failed | canceled, amount, payment_intent}. A checkout session that paid a Payment
 * Link is read with GET /v1/checkout/sessions/{id} to find its payment_intent when only the session id was stored.
 *
 * Mock mode exists ONLY when STRIPE_SECRET_KEY is unset AND NODE_ENV !== 'production' (the demo's mock deposits have no Stripe payment).
 * A failure is typed: `definite` = Stripe answered with an error (nothing was refunded: retry with a NEW key is safe), not definite =
 * the outcome is UNKNOWN (timeout / dropped connection): retry with the SAME key, never a new one.
 */
import { logger } from '@/lib/log';

const log = logger('stripe.refunds');
const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 15_000;

export class RefundProviderError extends Error {
  constructor(message: string, readonly definite: boolean, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'RefundProviderError';
  }
}

export interface ProviderRefund {
  id: string;
  /** Stripe's refund status, passed through ('succeeded' | 'pending' | 'requires_action' | 'failed' | 'canceled'). */
  status: string;
  amount_cents: number;
  payment_intent: string | null;
  mock: boolean;
}

const isProd = () => process.env.NODE_ENV === 'production';
export const stripeConfigured = (): boolean => Boolean(process.env.STRIPE_SECRET_KEY?.trim());
/** True when refunds can run at all (a key, or the non-production mock). */
export const refundsAvailable = (): boolean => stripeConfigured() || !isProd();

async function call<T>(method: 'GET' | 'POST', path: string, form?: URLSearchParams, idempotencyKey?: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log.warn('request.failed', { path, error: (err as Error).name });
    throw new RefundProviderError('Stripe could not be reached; the outcome is unknown', false);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & Record<string, unknown>;
  if (!res.ok) {
    log.warn('request.rejected', { path, status: res.status, code: json.error?.code });
    // 5xx and 429 may or may not have been applied: keep the key. 4xx is a definite refusal.
    throw new RefundProviderError(json.error?.message ?? `Stripe returned ${res.status}`, res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 409, res.status, json.error?.code);
  }
  return json as T;
}

/** The payment intent behind a checkout session (null when the session is unpaid / unknown). */
export async function paymentIntentOfSession(sessionId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  const s = await call<{ payment_intent?: string | { id?: string } | null }>('GET', `/checkout/sessions/${sessionId}`, undefined, undefined, fetchImpl);
  const pi = s.payment_intent;
  return typeof pi === 'string' ? pi : pi && typeof pi === 'object' && typeof pi.id === 'string' ? pi.id : null;
}

export interface CreateRefundInput {
  paymentIntentId: string | null;
  /** Only used when `paymentIntentId` is null: resolved through the session. */
  checkoutSessionId?: string | null;
  amountCents: number;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

/** Create one refund. Throws RefundProviderError. Never sends anything but ids, the amount and our own metadata. */
export async function createRefund(input: CreateRefundInput, fetchImpl: typeof fetch = fetch): Promise<ProviderRefund> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new RefundProviderError('amount must be a positive whole number of cents', true);
  if (!stripeConfigured()) {
    if (isProd()) throw new RefundProviderError('Stripe is not configured (STRIPE_SECRET_KEY unset)', true);
    log.warn('refund.mock', { amount_cents: input.amountCents, reason: 'no STRIPE_SECRET_KEY' });
    return { id: `re_mock_${input.idempotencyKey.slice(-24).replace(/[^A-Za-z0-9]/g, '')}`, status: 'succeeded', amount_cents: input.amountCents, payment_intent: input.paymentIntentId, mock: true };
  }
  let pi = input.paymentIntentId;
  if (!pi && input.checkoutSessionId) pi = await paymentIntentOfSession(input.checkoutSessionId, fetchImpl);
  if (!pi || !/^pi_[A-Za-z0-9_]+$/.test(pi)) throw new RefundProviderError('no Stripe payment is recorded for this deposit: refund it in your Stripe dashboard', true, undefined, 'no_payment_reference');
  const form = new URLSearchParams();
  form.set('payment_intent', pi);
  form.set('amount', String(input.amountCents));
  form.set('reason', 'requested_by_customer');
  for (const [k, v] of Object.entries(input.metadata ?? {})) form.set(`metadata[${k}]`, v.slice(0, 200));
  const r = await call<{ id?: string; status?: string; amount?: number; payment_intent?: string | null }>('POST', '/refunds', form, input.idempotencyKey, fetchImpl);
  if (!r.id) throw new RefundProviderError('Stripe returned no refund id', false);
  return { id: r.id, status: String(r.status ?? 'pending'), amount_cents: Math.round(Number(r.amount ?? input.amountCents)), payment_intent: r.payment_intent ?? pi, mock: false };
}
