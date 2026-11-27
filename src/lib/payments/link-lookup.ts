/**
 * Look up a booking's Stripe Payment Link for the public /pay/<bookingId> page: is it still payable, and where is it?
 * The page never renders a card form in production; it sends a customer with a live link to Stripe's own page.
 *
 * Bounded on purpose (the page is public): results are cached per link for a short TTL (positive and negative), and at most
 * MAX_LOOKUPS_PER_MINUTE Stripe calls are made per process; over that the answer is "unknown" (the page says the link is unavailable).
 * The URL is only trusted when it is an https `buy.stripe.com` address (a Stripe response can never turn the page into an open redirect).
 */
import { configEnv } from '@/lib/config';
import { logger } from '@/lib/log';

const log = logger('payments.link-lookup');

export type PaymentLinkLookup = { state: 'active'; url: string } | { state: 'inactive' } | { state: 'unknown' };

const TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const TIMEOUT_MS = 4_000;
const MAX_LOOKUPS_PER_MINUTE = 60;
const MAX_CACHE = 500;

const cache = new Map<string, { at: number; value: PaymentLinkLookup }>();
let windowStart = 0;
let windowCount = 0;

/** Test seam. */
export function resetLinkLookupCache(): void { cache.clear(); windowStart = 0; windowCount = 0; }

export const isStripeBuyUrl = (url: unknown): url is string => {
  if (typeof url !== 'string' || url.length > 300) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'buy.stripe.com' && !u.username && !u.password;
  } catch { return false; }
};

export async function lookupPaymentLink(linkId: string | null | undefined, opts: { fetchImpl?: typeof fetch; now?: number; secretKey?: string } = {}): Promise<PaymentLinkLookup> {
  const key = opts.secretKey ?? configEnv().STRIPE_SECRET_KEY;
  if (!key || !linkId || !/^plink_[A-Za-z0-9]{6,100}$/.test(linkId)) return { state: 'unknown' };
  const now = opts.now ?? Date.now();
  const hit = cache.get(linkId);
  if (hit && now - hit.at < (hit.value.state === 'active' || hit.value.state === 'inactive' ? TTL_MS : NEGATIVE_TTL_MS)) return hit.value;
  if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; }
  if (windowCount >= MAX_LOOKUPS_PER_MINUTE) return { state: 'unknown' };
  windowCount++;
  let value: PaymentLinkLookup = { state: 'unknown' };
  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://api.stripe.com/v1/payment_links/${encodeURIComponent(linkId)}`, {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store',
    });
    if (res.ok) {
      const json = (await res.json()) as { active?: unknown; url?: unknown };
      value = json.active === true && isStripeBuyUrl(json.url) ? { state: 'active', url: json.url } : { state: 'inactive' };
    } else if (res.status === 404) value = { state: 'inactive' };
    else log.warn('lookup.failed', { status: res.status });
  } catch (err) {
    log.warn('lookup.error', { err });
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(linkId, { at: now, value });
  return value;
}
