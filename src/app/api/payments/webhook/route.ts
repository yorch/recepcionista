import { ok, fail } from '@/lib/http';
import { insecureDevAllowed } from '@/lib/auth';
import { getBooking, getBusiness, markDepositPaid, claimEvent, releaseEvent } from '@/lib/db';
import { ownerAlertSms } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('stripe.webhook');

const RELEVANT = new Set([
  'checkout.session.completed',
  'payment_link.completed',
  'payment_intent.succeeded',
]);

/**
 * Stripe webhook. Signature verification is MANDATORY: with no
 * STRIPE_WEBHOOK_SECRET the request is refused (503). The only escape hatch is
 * STRIPE_ALLOW_UNSIGNED=true, which is ignored when NODE_ENV=production.
 * Verified payloads that we cannot use still answer 200 so Stripe does not
 * disable the endpoint.
 */
export async function POST(req: Request) {
  let raw = '';
  try {
    raw = await req.text();
  } catch (err) {
    return fail(err, 400);
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get('stripe-signature');
  const allowUnsigned = process.env.STRIPE_ALLOW_UNSIGNED === 'true' && insecureDevAllowed();

  if (secret) {
    const verdict = await verifySignature(raw, signature, secret);
    if (!verdict.ok) {
      log.warn('signature.rejected', { error: verdict.error });
      return fail('invalid signature', 400);
    }
  } else if (allowUnsigned) {
    log.warn('signature.unverified', { reason: 'STRIPE_ALLOW_UNSIGNED=true (development only)' });
  } else {
    log.error('signature.no_secret', { reason: 'STRIPE_WEBHOOK_SECRET unset; refusing webhook' });
    return fail('webhook verification not configured', 503);
  }

  let event: {
    id?: string;
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return ok({ received: true, ignored: 'unparseable body' });
  }

  const type = event.type ?? '';
  if (!RELEVANT.has(type)) {
    log.debug('event.ignored', { type, id: event.id ?? null });
    return ok({ received: true, ignored: type });
  }
  // Shared (Postgres) dedupe across instances. A DB error propagates as a 500 so Stripe retries.
  if (event.id && !(await claimEvent('stripe', event.id))) {
    log.info('event.duplicate', { type, id: event.id });
    return ok({ received: true, duplicate: true });
  }
  log.info('event.received', { type, id: event.id ?? null });
  try {
    return await handleEvent(event, type);
  } catch (err) {
    // Processing failed: give the claim back so Stripe's retry is processed, not dropped as a duplicate.
    if (event.id) await releaseEvent('stripe', event.id);
    log.error('event.failed', { type, id: event.id ?? null, err });
    return fail(err, 500);
  }
}

async function handleEvent(
  event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } },
  type: string,
) {

  const object = event.data?.object ?? {};
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  // Integer cents. Checkout sessions use amount_total; PaymentIntents amount_received/amount.
  const rawAmount = Number(object.amount_total ?? object.amount_received ?? object.amount ?? 0);
  const amountCents = Number.isFinite(rawAmount) ? Math.round(rawAmount) : 0;

  // A checkout session that is not paid yet (async payment methods) is not a deposit.
  if (type === 'checkout.session.completed' && object.payment_status && object.payment_status !== 'paid') {
    log.info('event.unpaid', { id: event.id ?? null, payment_status: object.payment_status });
    return ok({ received: true, ignored: 'not paid yet' });
  }

  const bookingId = metadata.booking_id ?? metadata.bookingId;
  const businessId = metadata.business_id ?? metadata.businessId;

  if (bookingId) {
    const booking = await getBooking(bookingId);
    // The metadata is ours, but never trust a booking that belongs to another business.
    if (booking && (!businessId || booking.business_id === businessId) && amountCents > 0) {
      const { updated } = await markDepositPaid(booking.id, amountCents);
      if (updated) {
        const business = await getBusiness(booking.business_id);
        if (business?.owner_phone) {
          await sendAndLog({
            business_id: business.id,
            to: business.owner_phone,
            body: ownerAlertSms({
              business,
              text: `Deposit ${money(amountCents)} paid by ${booking.customer_name} for ${booking.service}.`,
            }),
            kind: 'owner_alert',
            booking_id: booking.id,
          });
        }
      }
      return ok({ received: true, booking_id: booking.id, deposit_paid: updated });
    }
    log.warn('booking.unmatched', { booking: bookingId, type, amount_cents: amountCents });
  }

  // Unmatched payment: never drop money on the floor — tell the owner instead.
  const business = businessId ? await getBusiness(businessId) : null;
  if (!(amountCents > 0)) {
    log.info('payment.unmatched_zero', { type });
  } else if (business?.owner_phone) {
    await sendAndLog({
      business_id: business.id,
      to: business.owner_phone,
      body: ownerAlertSms({
        business,
        text: `Payment of ${money(amountCents)} came in without a booking match. Check Stripe.`,
      }),
      kind: 'owner_alert',
    });
  } else {
    log.warn('payment.unattributed', { amount: money(amountCents), type });
  }

  return ok({ received: true, unmatched: true });
}

function money(cents: number): string {
  return `$${(Math.round(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/**
 * Stripe's scheme: `t=<unix>,v1=<hmac-sha256 of "t.payload">`. Checked with Web
 * Crypto so it runs on both the Node and Edge runtimes.
 */
async function verifySignature(
  payload: string,
  header: string | null,
  secret: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!header) return { ok: false, error: 'missing stripe-signature header' };

  let timestamp = '';
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1' && v) candidates.push(v);
  }
  if (!timestamp || candidates.length === 0) return { ok: false, error: 'malformed stripe-signature header' };

  // 5 minutes of tolerance, as Stripe recommends, so a replay is not accepted.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, error: 'timestamp outside tolerance' };

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    );
    const expected = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return candidates.some((c) => timingSafeEqual(expected, c))
      ? { ok: true }
      : { ok: false, error: 'mismatch' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
