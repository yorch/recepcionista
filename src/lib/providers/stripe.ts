/**
 * Stripe payment links. Mock mode returns a local /pay/[id] page that renders a
 * convincing test checkout, so the demo works before keys are wired.
 */
import type { PaymentLink } from '@/lib/types';
import { logger } from '@/lib/log';

const log = logger('stripe');

export const hasStripe = () => Boolean(process.env.STRIPE_SECRET_KEY);

export interface PaymentLinkOptions {
  /** Stored as Stripe metadata so the webhook can confirm the right booking. */
  bookingId?: string | null;
  businessId?: string | null;
}

const STRIPE_TIMEOUT_MS = 15_000;
const isProd = () => process.env.NODE_ENV === 'production';

function mockLink(amountCents: number, reason: string, bookingId?: string | null): PaymentLink & { mock: boolean } {
  const id = `mock_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  log.warn('link.mock', { reason, amount_cents: amountCents, id });
  // With a booking the pay page loads amount/description from the DB by booking id.
  const path = bookingId ? encodeURIComponent(bookingId) : id;
  return { id, url: `${appUrl()}/pay/${path}`, amount_cents: amountCents, mock: true };
}

/**
 * Create a single-use Stripe Payment Link. Metadata carries booking_id and
 * business_id (on the link, the checkout session and the PaymentIntent).
 * In production a Stripe failure throws; the mock checkout exists only
 * outside production.
 */
export async function createPaymentLink(
  amountCents: number,
  description: string,
  /** Shown on the customer's card statement; Stripe truncates to 22 chars. */
  businessName?: string,
  opts: PaymentLinkOptions = {},
): Promise<PaymentLink & { mock: boolean }> {
  const cents = Math.round(amountCents);
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('amount_cents must be a positive integer');
  if (!hasStripe()) {
    if (isProd()) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY unset)');
    return mockLink(cents, 'no STRIPE_SECRET_KEY', opts.bookingId);
  }
  try {
    const started = Date.now();
    const form = new URLSearchParams();
    form.set('line_items[0][price_data][currency]', 'usd');
    form.set('line_items[0][price_data][product_data][name]', businessName ? `${businessName}: ${description}` : description);
    form.set('line_items[0][price_data][unit_amount]', String(cents));
    form.set('line_items[0][quantity]', '1');
    for (const method of ['card']) form.append('payment_method_types[]', method);
    // Single use: the link deactivates after one completed checkout.
    form.set('restrictions[completed_sessions][limit]', '1');
    if (opts.bookingId) {
      form.set('metadata[booking_id]', opts.bookingId);
      form.set('payment_intent_data[metadata][booking_id]', opts.bookingId);
    }
    if (opts.businessId) {
      form.set('metadata[business_id]', opts.businessId);
      form.set('payment_intent_data[metadata][business_id]', opts.businessId);
    }
    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? String(res.status));
    log.info('link.created', {
      id: json.id,
      amount_cents: cents,
      booking: opts.bookingId ?? null,
      ms: Date.now() - started,
    });
    return { id: json.id, url: json.url, amount_cents: cents, mock: false };
  } catch (err) {
    if (isProd()) {
      log.error('link.failed', { amount_cents: cents, err });
      throw err instanceof Error ? err : new Error('Stripe payment link failed');
    }
    log.warn('link.fallback_to_mock', { amount_cents: cents, err });
    return mockLink(cents, 'stripe error (non-production)', opts.bookingId);
  }
}

export function appUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}
