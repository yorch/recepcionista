import { configEnv, verifierSecrets } from '@/lib/config';
import { ok, fail } from '@/lib/http';
import { insecureDevAllowed } from '@/lib/auth';
import { claimEvent, completeEvent, releaseEvent } from '@/lib/db';
import { verifyStripeSignature } from '@/lib/billing/signature';
import { processBillingEvent, HANDLED_TYPES, type StripeEvent } from '@/lib/billing/webhook';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('billing.webhook');
const SOURCE = 'stripe-billing';

/**
 * Stripe Billing webhook (subscription lifecycle). Public path: authenticity comes from the Stripe-Signature
 * header, verified against STRIPE_BILLING_WEBHOOK_SECRET (a different endpoint secret from the deposit webhook).
 * With no secret the request is refused (503) unless ALLOW_INSECURE_DEV=true outside production.
 * Verified events we cannot use answer 200 so Stripe does not disable the endpoint; a processing failure answers
 * 500 and releases the claim so Stripe's retry is processed.
 */
export async function POST(req: Request) {
  let raw = '';
  try {
    raw = await req.text();
  } catch (err) {
    return fail(err, 400);
  }

  const secret = configEnv().STRIPE_BILLING_WEBHOOK_SECRET?.trim();
  if (secret) {
    let verdict = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), secret);
    for (const prev of verifierSecrets('stripe.billing_webhook_secret', secret).slice(1)) if (!verdict.ok) verdict = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), prev); // the previous secret, 15 minutes after a console rotation
    if (!verdict.ok) {
      log.warn('signature.rejected', { error: verdict.error });
      return fail('invalid signature', 400);
    }
  } else if (insecureDevAllowed()) {
    log.warn('signature.unverified', { reason: 'ALLOW_INSECURE_DEV=true (development only)' });
  } else {
    log.error('signature.no_secret', { reason: 'STRIPE_BILLING_WEBHOOK_SECRET unset; refusing webhook' });
    return fail('webhook verification not configured', 503);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return ok({ received: true, ignored: 'unparseable body' });
  }
  if (!event || typeof event !== 'object') return ok({ received: true, ignored: 'unparseable body' });

  const type = typeof event.type === 'string' ? event.type : '';
  const id = typeof event.id === 'string' && event.id ? event.id : null;
  if (!HANDLED_TYPES.has(type)) return ok({ received: true, ignored: type || 'untyped' });
  if (!id) return ok({ received: true, ignored: 'event without id' });

  // Shared (Postgres) dedupe. A database error propagates as a 500 so Stripe retries.
  if (!(await claimEvent(SOURCE, id))) {
    log.info('event.duplicate', { type, id });
    return ok({ received: true, duplicate: true });
  }
  try {
    const outcome = await processBillingEvent(event);
    await completeEvent(SOURCE, id);
    if (!outcome.handled) {
      log.info('event.skipped', { type, id, reason: outcome.reason });
      return ok({ received: true, ignored: outcome.reason });
    }
    log.info('event.applied', { type, id, business: outcome.business_id, detail: outcome.detail ?? null });
    return ok({ received: true, business_id: outcome.business_id });
  } catch (err) {
    await releaseEvent(SOURCE, id);
    log.error('event.failed', { type, id, err });
    return fail(err, 500);
  }
}
