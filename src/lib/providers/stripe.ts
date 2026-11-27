/**
 * Stripe payment links. Mock mode returns a local /pay/[id] page that renders a
 * convincing test checkout, so the demo works before keys are wired.
 */
import { configEnv } from '@/lib/config';
import type { PaymentLink } from '@/lib/types';
import { demoModeEnabled } from '@/lib/auth';
import { logger } from '@/lib/log';
import { baseUrlOrDev } from '@/lib/base-url';

const log = logger('stripe');

export const hasStripe = () => Boolean(configEnv().STRIPE_SECRET_KEY);

export interface PaymentLinkOptions {
  /** Stored as Stripe metadata so the webhook can confirm the right booking. */
  bookingId?: string | null;
  businessId?: string | null;
  /** Shown beside the Pay button on Stripe's page (Payment Links custom_text.submit.message, max 1200 chars): the refund policy. */
  refundNote?: string | null;
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
 * A Stripe failure throws (in production always; elsewhere unless DEMO_MODE=true, which swaps in the mock
 * checkout). With no STRIPE_SECRET_KEY at all the mock checkout exists only outside production.
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
    if (opts.refundNote) form.set('custom_text[submit][message]', opts.refundNote.slice(0, 1200));
    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${configEnv().STRIPE_SECRET_KEY}`,
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
    // A real Stripe key that FAILS is an error everywhere. Only explicit demo mode (never production) may swap in the mock checkout.
    if (isProd() || !demoModeEnabled()) {
      log.error('link.failed', { amount_cents: cents, err });
      throw err instanceof Error ? err : new Error('Stripe payment link failed');
    }
    log.warn('link.fallback_to_mock', { amount_cents: cents, err });
    return mockLink(cents, 'stripe error (non-production)', opts.bookingId);
  }
}

/**
 * Deactivate a Payment Link (POST /v1/payment_links/{id} active=false) so a cancelled booking's link stops accepting money. Idempotent at
 * Stripe. Returns false (never throws) when Stripe is not configured, the id is not a real link, or the call failed (the webhook still
 * alerts the owner if the link is paid anyway).
 */
export async function deactivatePaymentLink(linkId: string, fetchImpl: typeof fetch = fetch, timeoutMs: number = STRIPE_TIMEOUT_MS): Promise<boolean> {
  if (!hasStripe() || !/^plink_[A-Za-z0-9]{6,100}$/.test(linkId)) return false;
  try {
    const res = await fetchImpl(`https://api.stripe.com/v1/payment_links/${encodeURIComponent(linkId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${configEnv().STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ active: 'false' }),
      signal: AbortSignal.timeout(Math.max(500, Math.min(timeoutMs, STRIPE_TIMEOUT_MS))),
    });
    if (!res.ok) log.warn('link.deactivate_failed', { status: res.status });
    return res.ok;
  } catch (err) {
    log.warn('link.deactivate_error', { err });
    return false;
  }
}

/**
 * Active Payment Links this app created for ONE booking, found through Stripe (GET /v1/payment_links?active=true, newest first, then matched on
 * our `booking_id` metadata). Used only when the booking has no stored link id (a link texted before the id was stored). Bounded: at most
 * `maxPages` pages of 100 and `budgetMs` in total, so a cancel never hangs on a big account. `complete` is false when Stripe failed (the caller may retry); nothing is returned when Stripe is not configured.
 * NEVER on a request path: the caller runs it in the background (payments/link-store.ts), because the platform account's active list holds every tenant's links.
 * Stripe has no metadata filter for payment links, so an account with more than `maxPages * 100` active links is only searched that far (documented).
 */
export async function findActivePaymentLinksForBooking(bookingId: string, opts: { fetchImpl?: typeof fetch; maxPages?: number; budgetMs?: number; businessId?: string } = {}): Promise<{ ids: string[]; complete: boolean }> {
  if (!hasStripe() || !/^[0-9a-f-]{36}$/i.test(bookingId)) return { ids: [], complete: true };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const found: string[] = [];
  let after: string | null = null;
  try {
    for (let page = 0; page < (opts.maxPages ?? 5) && Date.now() < deadline; page++) {
      const qs = new URLSearchParams({ active: 'true', limit: '100' });
      if (after) qs.set('starting_after', after);
      const res = await fetchImpl(`https://api.stripe.com/v1/payment_links?${qs}`, {
        headers: { authorization: `Bearer ${configEnv().STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(Math.min(STRIPE_TIMEOUT_MS, Math.max(1000, deadline - Date.now()))),
      });
      if (!res.ok) { log.warn('link.lookup_failed', { status: res.status }); return { ids: found, complete: false }; }
      const json = (await res.json()) as { data?: { id?: string; metadata?: Record<string, string> | null }[]; has_more?: boolean };
      const rows = json.data ?? [];
      // Tenant scope: the platform account holds every business's links; a link counts only when it names this booking AND (when it names one) this business.
      for (const r of rows) if (typeof r.id === 'string' && r.metadata?.booking_id === bookingId && (!opts.businessId || !r.metadata?.business_id || r.metadata.business_id === opts.businessId)) found.push(r.id);
      if (!json.has_more || rows.length === 0) break;
      after = rows[rows.length - 1].id ?? null;
      if (!after) break;
    }
  } catch (err) {
    log.warn('link.lookup_error', { err });
    return { ids: found, complete: false };
  }
  return { ids: found, complete: true }; // reaching the page / time budget without an error is final (the documented bound); `complete: false` is an error
}

/** Public origin for payment links and agent webhook URLs: the single resolver (src/lib/base-url.ts). */
export function appUrl(): string {
  return baseUrlOrDev();
}
