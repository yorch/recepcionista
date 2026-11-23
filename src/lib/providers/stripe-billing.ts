/**
 * Stripe Billing (subscriptions) over fetch, with timeouts. Separate from stripe.ts (deposit payment links).
 *
 * Mock mode exists ONLY when STRIPE_SECRET_KEY is unset AND NODE_ENV !== 'production': checkout then points at
 * /api/billing/mock-activate (itself gated by DEMO_MODE=true and the owner's session). In production a missing
 * key / price throws BillingConfigError (routes answer 503). A Stripe API failure throws BillingProviderError.
 */
import { logger } from '@/lib/log';

const log = logger('stripe.billing');

const TIMEOUT_MS = 15_000;
const API = 'https://api.stripe.com/v1';

export const DEFAULT_TRIAL_DAYS = 7;

/** Billing is not configured (missing key/price/base URL). Surface as 503. */
export class BillingConfigError extends Error {
  readonly code = 'billing_not_configured';
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

/** Stripe refused or could not be reached. Surface as 502. */
export class BillingProviderError extends Error {
  readonly code = 'billing_provider_error';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'BillingProviderError';
  }
}

const isProd = (env: NodeJS.ProcessEnv = process.env) => env.NODE_ENV === 'production';

/** 'live' = real Stripe; 'mock' = local activation (never in production). Throws BillingConfigError otherwise. */
export function billingMode(env: NodeJS.ProcessEnv = process.env): 'live' | 'mock' {
  if (env.STRIPE_SECRET_KEY?.trim()) {
    if (!env.STRIPE_PRICE_ID?.trim()) throw new BillingConfigError('STRIPE_PRICE_ID is not set');
    return 'live';
  }
  if (isProd(env)) throw new BillingConfigError('Stripe billing is not configured (STRIPE_SECRET_KEY unset)');
  return 'mock';
}

/** Trial length in days (BILLING_TRIAL_DAYS, default 7, 0..90; invalid values fall back to the default). */
export function trialDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BILLING_TRIAL_DAYS?.trim();
  if (!raw) return DEFAULT_TRIAL_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 90 ? n : DEFAULT_TRIAL_DAYS;
}

/** Plan label stored on the business for Stripe-managed subscriptions. */
export const planName = (env: NodeJS.ProcessEnv = process.env): string => env.BILLING_PLAN_NAME?.trim() || 'standard';

/** Public origin for return URLs: PUBLIC_BASE_URL, else APP_URL. Required in production. */
export function returnBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PUBLIC_BASE_URL || env.APP_URL || '').trim().replace(/\/+$/, '');
  if (base) return base;
  if (isProd(env)) throw new BillingConfigError('APP_URL (or PUBLIC_BASE_URL) is required for billing return URLs');
  return 'http://localhost:3000';
}

async function stripe<T>(method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log.warn('request.failed', { path, error: (err as Error).name });
    throw new BillingProviderError('Stripe request failed');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
  if (!res.ok) {
    log.warn('request.rejected', { path, status: res.status, message: json.error?.message });
    throw new BillingProviderError(json.error?.message ?? `Stripe returned ${res.status}`, res.status);
  }
  return json as T;
}

export interface BillingBusiness {
  id: string;
  name: string;
  stripe_customer_id?: string | null;
}

/** Create a Stripe Customer for the business (metadata.business_id lets the webhook find it again). */
export async function createCustomer(b: BillingBusiness, email?: string | null): Promise<string> {
  const form = new URLSearchParams();
  form.set('name', b.name.slice(0, 200));
  if (email) form.set('email', email);
  form.set('metadata[business_id]', b.id);
  const json = await stripe<{ id: string }>('POST', '/customers', form);
  if (!json.id) throw new BillingProviderError('Stripe returned no customer id');
  return json.id;
}

export interface CheckoutInput {
  business: BillingBusiness;
  customerId: string;
  /** false when this business already used its trial (no second free trial). */
  withTrial: boolean;
}

/** Subscription Checkout Session: trial + card collected up front. Returns the hosted URL. */
export async function createCheckoutSession(input: CheckoutInput, env: NodeJS.ProcessEnv = process.env): Promise<{ url: string; id: string }> {
  const price = env.STRIPE_PRICE_ID?.trim();
  if (!price) throw new BillingConfigError('STRIPE_PRICE_ID is not set');
  const base = returnBaseUrl(env);
  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('customer', input.customerId);
  form.set('client_reference_id', input.business.id);
  form.set('line_items[0][price]', price);
  form.set('line_items[0][quantity]', '1');
  form.set('payment_method_collection', 'always');
  form.set('subscription_data[metadata][business_id]', input.business.id);
  form.set('metadata[business_id]', input.business.id);
  const days = trialDays(env);
  if (input.withTrial && days > 0) {
    form.set('subscription_data[trial_period_days]', String(days));
    // A trial that ends with no usable card cancels instead of silently lapsing.
    form.set('subscription_data[trial_settings][end_behavior][missing_payment_method]', 'cancel');
  }
  if (env.BILLING_ALLOW_PROMO_CODES === 'true') form.set('allow_promotion_codes', 'true');
  form.set('success_url', `${base}/dashboard/billing?checkout=success`);
  form.set('cancel_url', `${base}/dashboard/billing?checkout=cancel`);
  const json = await stripe<{ id: string; url?: string }>('POST', '/checkout/sessions', form);
  if (!json.url) throw new BillingProviderError('Stripe returned no checkout url');
  return { url: json.url, id: json.id };
}

/** Customer Portal session (manage card, cancel, invoices). */
export async function createPortalSession(customerId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ url: string }> {
  const form = new URLSearchParams();
  form.set('customer', customerId);
  form.set('return_url', `${returnBaseUrl(env)}/dashboard/billing`);
  const json = await stripe<{ url?: string }>('POST', '/billing_portal/sessions', form);
  if (!json.url) throw new BillingProviderError('Stripe returned no portal url');
  return { url: json.url };
}

export interface RetrievedSubscription {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string>;
  trial_end?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null }> };
}

export async function retrieveSubscription(id: string): Promise<RetrievedSubscription> {
  if (!/^sub_[A-Za-z0-9_]+$/.test(id)) throw new BillingProviderError('invalid subscription id');
  return stripe<RetrievedSubscription>('GET', `/subscriptions/${id}`);
}
