import { ok, fail } from '@/lib/http';
import { getBusiness, updateBooking } from '@/lib/db';
import { ownerAlertSms } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';

export const dynamic = 'force-dynamic';

const RELEVANT = new Set([
  'checkout.session.completed',
  'payment_link.completed',
  'payment_intent.succeeded',
]);

/**
 * Stripe webhook. Signature verification is enforced only when a secret is
 * configured; in test mode we accept and say so in the log, because a demo run
 * has no way to generate a valid signature. Always answers 200 so Stripe does
 * not disable the endpoint over a payload we did not need.
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

  if (secret) {
    const verdict = await verifySignature(raw, signature, secret);
    if (!verdict.ok) {
      console.warn('[stripe] webhook signature rejected:', verdict.error);
      // 400 here on purpose: a forged payload is the one case worth failing.
      return fail(`signature ${verdict.error}`, 400);
    }
  } else {
    console.warn('[stripe] STRIPE_WEBHOOK_SECRET unset — accepting unverified webhook (test mode)');
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
  if (!RELEVANT.has(type)) return ok({ received: true, ignored: type });

  const object = event.data?.object ?? {};
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  const amountCents = Number(object.amount_total ?? object.amount_total_cents ?? object.amount ?? 0);

  // Preferred path: the link was created with a booking_id in metadata.
  const bookingId = metadata.booking_id ?? metadata.bookingId;
  const businessId = metadata.business_id ?? metadata.businessId;

  if (bookingId) {
    const booking = updateBooking(bookingId, { deposit_paid: true, status: 'confirmed' });
    if (booking) {
      const business = getBusiness(booking.business_id) ?? (businessId ? getBusiness(businessId) : null);
      if (business?.owner_phone) {
        await sendAndLog({
          business_id: business.id,
          to: business.owner_phone,
          body: ownerAlertSms({
            business,
            text: `Deposit ${money(amountCents)} paid by ${booking.customer_name} for ${booking.service}. Booking confirmed.`,
          }),
          kind: 'owner_alert',
        });
      }
      return ok({ received: true, booking_id: booking.id, deposit_paid: true });
    }
    console.warn(`[stripe] webhook referenced unknown booking ${bookingId}`);
  }

  // Unmatched payment: never drop money on the floor — tell the owner instead.
  const business = businessId ? getBusiness(businessId) : null;
  if (business?.owner_phone) {
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
    console.warn(`[stripe] payment of ${money(amountCents)} (${type}) with no booking/business metadata`);
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

  const parts = header.split(',').reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) return { ok: false, error: 'malformed stripe-signature header' };

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
    return timingSafeEqual(expected, provided)
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
