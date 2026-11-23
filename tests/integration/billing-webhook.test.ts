/**
 * POST /api/billing/webhook with correctly signed Stripe subscription events against a real database.
 */
import { integration, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cleanup, eventId, loadDb, loadPrisma, newBusiness, stripeSignature, uniq } from '../helpers/fixtures';
import { createHmac } from 'node:crypto';

const SECRET = 'whsec_billing_integration_secret';

integration('billing webhook (postgres)', () => {
  let POST: (req: Request) => Promise<Response>;
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = SECRET;
    POST = (await import('@/app/api/billing/webhook/route')).POST;
  });
  afterAll(async () => {
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    await cleanup();
  });

  const now = () => Math.floor(Date.now() / 1000);
  const DAY = 86_400;

  function event(type: string, object: Record<string, unknown>, id = eventId()) {
    return { id, object: 'event', api_version: '2024-06-20', created: now(), livemode: false, type, data: { object } };
  }
  function sub(o: { id: string; customer: string; business?: string; status: string; extra?: Record<string, unknown> }) {
    return {
      id: o.id, object: 'subscription', customer: o.customer, status: o.status,
      metadata: o.business ? { business_id: o.business } : {},
      trial_end: o.status === 'trialing' ? now() + 7 * DAY : null,
      current_period_end: now() + 30 * DAY, cancel_at_period_end: false, ...o.extra,
    };
  }
  function send(ev: unknown, opts: { sig?: string | null; t?: number; secret?: string; body?: string; headerExtra?: string } = {}) {
    const body = opts.body ?? JSON.stringify(ev);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let sig = opts.sig === undefined ? stripeSignature(body, { t: opts.t, secret: opts.secret ?? SECRET }) : opts.sig;
    if (sig && opts.headerExtra) sig = `${sig},${opts.headerExtra}`;
    if (sig) headers['stripe-signature'] = sig;
    return POST(new Request('https://app.example.test/api/billing/webhook', { method: 'POST', headers, body }));
  }
  const json = async (res: Response) => (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  const row = (id: string) => prisma.business.findUniqueOrThrow({ where: { id } });
  const audits = (businessId: string, action: string) => prisma.auditEvent.findMany({ where: { businessId, action } });

  test('signature: missing, wrong secret, stale timestamp and tampered body are rejected; nothing is applied', async () => {
    const biz = await newBusiness();
    const ev = event('customer.subscription.created', sub({ id: uniq('sub'), customer: uniq('cus'), business: biz.id, status: 'trialing' }));
    expect((await send(ev, { sig: null })).status).toBe(400);
    expect((await send(ev, { secret: 'whsec_other' })).status).toBe(400);
    expect((await send(ev, { t: now() - 3600 })).status).toBe(400);
    const body = JSON.stringify(ev);
    expect((await send(ev, { body: body.replace('trialing', 'active'), sig: stripeSignature(body, { secret: SECRET }) })).status).toBe(400);
    expect((await row(biz.id)).billingStatus).toBe('none');
  });

  test('signature: several v1 values are tolerated (secret rotation) and v0 is ignored', async () => {
    const biz = await newBusiness();
    const ev = event('customer.subscription.created', sub({ id: uniq('sub'), customer: uniq('cus'), business: biz.id, status: 'trialing' }));
    const body = JSON.stringify(ev);
    const t = now();
    const good = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    const res = await send(ev, { body, sig: `t=${t},v0=junk,v1=${'a'.repeat(64)},v1=${good}` });
    expect(res.status).toBe(200);
    expect((await row(biz.id)).billingStatus).toBe('trialing');
  });

  test('fails closed (503) with no secret; ALLOW_INSECURE_DEV accepts unsigned outside production only', async () => {
    const biz = await newBusiness();
    const ev = event('customer.subscription.created', sub({ id: uniq('sub'), customer: uniq('cus'), business: biz.id, status: 'trialing' }));
    await withEnv({ STRIPE_BILLING_WEBHOOK_SECRET: undefined }, async () => {
      expect((await send(ev, { sig: null })).status).toBe(503);
      expect((await send(ev)).status).toBe(503);
      // the payments secret must NOT stand in for the billing secret
      await withEnv({ ALLOW_INSECURE_DEV: 'true', NODE_ENV: 'production' }, async () => {
        expect((await send(ev, { sig: null })).status).toBe(503);
      });
      expect((await row(biz.id)).billingStatus).toBe('none');
      await withEnv({ ALLOW_INSECURE_DEV: 'true' }, async () => {
        expect((await send(ev, { sig: null })).status).toBe(200);
      });
    });
    expect((await row(biz.id)).billingStatus).toBe('trialing');
  });

  test('replay of the same event id is a duplicate and does not re-apply', async () => {
    const biz = await newBusiness();
    const cus = uniq('cus');
    const ev = event('customer.subscription.created', sub({ id: uniq('sub'), customer: cus, business: biz.id, status: 'trialing' }));
    const first = await json(await send(ev));
    expect(first.data).toMatchObject({ received: true, business_id: biz.id });
    await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'active' } }); // tamper to prove no re-apply
    const second = await json(await send(ev));
    expect(second.data).toMatchObject({ received: true, duplicate: true });
    expect((await row(biz.id)).billingStatus).toBe('active');
  });

  test('unknown event types, unparseable bodies and unknown customers answer 200 without touching anything', async () => {
    const other = await send(event('charge.refunded', { id: 'ch_1' }));
    expect((await json(other)).data).toMatchObject({ received: true, ignored: 'charge.refunded' });
    const bad = '{not json';
    expect((await json(await send(null, { body: bad, sig: stripeSignature(bad, { secret: SECRET }) }))).data).toMatchObject({ ignored: 'unparseable body' });
    const unknown = await send(event('customer.subscription.updated', sub({ id: uniq('sub'), customer: uniq('cus_nobody'), status: 'active' })));
    expect(unknown.status).toBe(200);
    expect((await json(unknown)).data).toMatchObject({ received: true, ignored: 'unknown customer' });
  });

  test('checkout.session.completed (subscription) links customer and subscription; deposit checkouts are ignored', async () => {
    const biz = await newBusiness();
    const cus = uniq('cus');
    const subId = uniq('sub');
    const res = await send(event('checkout.session.completed', {
      id: uniq('cs'), object: 'checkout.session', mode: 'subscription', customer: cus, subscription: subId,
      client_reference_id: biz.id, metadata: { business_id: biz.id }, payment_status: 'no_payment_required',
    }));
    expect((await json(res)).data).toMatchObject({ business_id: biz.id });
    const r = await row(biz.id);
    expect(r.stripeCustomerId).toBe(cus);
    expect(r.stripeSubscriptionId).toBe(subId);
    expect((await db.getBusinessByStripeCustomer(cus))?.id).toBe(biz.id);

    const deposit = await send(event('checkout.session.completed', {
      id: uniq('cs'), object: 'checkout.session', mode: 'payment', customer: null, metadata: { business_id: biz.id, booking_id: 'x' }, payment_status: 'paid',
    }));
    expect((await json(deposit)).data).toMatchObject({ ignored: 'not a subscription checkout' });
  });

  test('lifecycle: trial -> active -> past_due -> recovered -> canceled', async () => {
    const biz = await newBusiness();
    const cus = uniq('cus');
    const subId = uniq('sub');

    // subscription.created before any checkout event: found through metadata, customer gets linked
    await send(event('customer.subscription.created', sub({ id: subId, customer: cus, business: biz.id, status: 'trialing' })));
    let r = await row(biz.id);
    expect(r).toMatchObject({ billingStatus: 'trialing', stripeCustomerId: cus, stripeSubscriptionId: subId, plan: 'standard' });
    expect(r.trialEndsAt).not.toBeNull();
    expect(r.currentPeriodEnd).not.toBeNull();
    expect(r.pastDueSince).toBeNull();
    expect(db.isProvisioningAllowed({ billing_status: 'trialing', past_due_since: null })).toBe(true);

    // trial converts (no metadata needed any more: found by customer)
    await send(event('customer.subscription.updated', sub({ id: subId, customer: cus, status: 'active', extra: { trial_end: now() - DAY } })));
    r = await row(biz.id);
    expect(r.billingStatus).toBe('active');

    // payment fails -> past_due with a grace period start
    await send(event('invoice.payment_failed', { id: uniq('in'), object: 'invoice', customer: cus, subscription: subId }));
    r = await row(biz.id);
    expect(r.billingStatus).toBe('past_due');
    const since = r.pastDueSince;
    expect(since).not.toBeNull();
    expect((await audits(biz.id, 'billing.payment_failed')).length).toBe(1);

    // a retry of the failure keeps the ORIGINAL grace start
    await send(event('invoice.payment_failed', { id: uniq('in'), object: 'invoice', customer: cus, subscription: subId }));
    expect((await row(biz.id)).pastDueSince?.getTime()).toBe(since!.getTime());

    // invoice.paid recovers (new-API shape: subscription under parent.subscription_details)
    await send(event('invoice.paid', {
      id: uniq('in'), object: 'invoice', customer: cus, parent: { subscription_details: { subscription: subId } },
      lines: { data: [{ period: { end: now() + 60 * DAY } }] },
    }));
    r = await row(biz.id);
    expect(r.billingStatus).toBe('active');
    expect(r.pastDueSince).toBeNull();
    expect(r.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 50 * DAY * 1000);

    // scheduled cancellation, then deletion
    await send(event('customer.subscription.updated', sub({ id: subId, customer: cus, status: 'active', extra: { cancel_at_period_end: true } })));
    expect((await row(biz.id)).cancelAtPeriodEnd).toBe(true);
    await send(event('customer.subscription.deleted', sub({ id: subId, customer: cus, status: 'active' })));
    r = await row(biz.id);
    expect(r.billingStatus).toBe('canceled');
    expect(db.billingStateAllows({ billing_status: 'canceled', past_due_since: null })).toBe(false);

    // a stray payment_failed / paid after cancellation does not resurrect or re-open grace
    await send(event('invoice.payment_failed', { id: uniq('in'), object: 'invoice', customer: cus, subscription: subId }));
    await send(event('invoice.paid', { id: uniq('in'), object: 'invoice', customer: cus, subscription: subId }));
    expect((await row(biz.id)).billingStatus).toBe('canceled');
  });

  test('stripe statuses map: unpaid, incomplete -> none', async () => {
    const biz = await newBusiness();
    const cus = uniq('cus');
    const subId = uniq('sub');
    await send(event('customer.subscription.created', sub({ id: subId, customer: cus, business: biz.id, status: 'incomplete' })));
    expect((await row(biz.id)).billingStatus).toBe('none');
    // a payment_failed for a never-paid subscription must not grant a grace period
    await send(event('invoice.payment_failed', { id: uniq('in'), object: 'invoice', customer: cus, subscription: subId }));
    expect((await row(biz.id)).billingStatus).toBe('none');
    await send(event('customer.subscription.updated', sub({ id: subId, customer: cus, status: 'unpaid' })));
    expect((await row(biz.id)).billingStatus).toBe('unpaid');
  });

  test('the $0 invoice that starts a trial does not end the trial; trial_will_end changes nothing', async () => {
    const biz = await newBusiness();
    const cus = uniq('cus');
    const subId = uniq('sub');
    await send(event('customer.subscription.created', sub({ id: subId, customer: cus, business: biz.id, status: 'trialing' })));
    await send(event('invoice.paid', { id: uniq('in'), object: 'invoice', customer: cus, subscription: subId, amount_paid: 0 }));
    expect((await row(biz.id)).billingStatus).toBe('trialing');
    const res = await send(event('customer.subscription.trial_will_end', sub({ id: subId, customer: cus, status: 'trialing' })));
    expect((await json(res)).data).toMatchObject({ business_id: biz.id });
    expect((await row(biz.id)).billingStatus).toBe('trialing');
  });

  test('customer mismatch is refused: metadata cannot move a business to another customer or steal one', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const cusA = uniq('cus_a');
    const cusB = uniq('cus_b');
    const subA = uniq('sub');
    await send(event('customer.subscription.created', sub({ id: subA, customer: cusA, business: a.id, status: 'active' })));
    expect((await row(a.id)).stripeCustomerId).toBe(cusA);

    // A already has cusA: an event for A's metadata but another customer is refused
    const hijack = await send(event('customer.subscription.updated', sub({ id: uniq('sub'), customer: cusB, business: a.id, status: 'canceled' })));
    expect(hijack.status).toBe(200);
    expect((await json(hijack)).data).toMatchObject({ ignored: 'business/customer mismatch' });
    expect(await row(a.id)).toMatchObject({ billingStatus: 'active', stripeCustomerId: cusA, stripeSubscriptionId: subA });

    // B's metadata but A's customer: refused, B untouched, A untouched
    const steal = await send(event('customer.subscription.updated', sub({ id: uniq('sub'), customer: cusA, business: b.id, status: 'active' })));
    expect((await json(steal)).data).toMatchObject({ ignored: 'business/customer mismatch' });
    expect(await row(b.id)).toMatchObject({ billingStatus: 'none', stripeCustomerId: null });
    expect((await audits(a.id, 'billing.webhook_refused')).length).toBe(1);
    expect((await audits(b.id, 'billing.webhook_refused')).length).toBe(1);

    // metadata naming a business that does not exist
    const ghost = await send(event('customer.subscription.created', sub({ id: uniq('sub'), customer: uniq('cus'), business: 'biz_does_not_exist', status: 'active' })));
    expect((await json(ghost)).data).toMatchObject({ ignored: 'unknown business' });
  });

  test('a late event about an older, replaced subscription is ignored', async () => {
    const biz = await newBusiness();
    const cus = uniq('cus');
    const oldSub = uniq('sub_old');
    const newSub = uniq('sub_new');
    await send(event('customer.subscription.created', sub({ id: oldSub, customer: cus, business: biz.id, status: 'active' })));
    await send(event('customer.subscription.deleted', sub({ id: oldSub, customer: cus, status: 'canceled' })));
    expect((await row(biz.id)).billingStatus).toBe('canceled');
    // resubscribe: a new subscription is accepted
    await send(event('customer.subscription.created', sub({ id: newSub, customer: cus, status: 'active' })));
    expect(await row(biz.id)).toMatchObject({ billingStatus: 'active', stripeSubscriptionId: newSub });
    // the old subscription's late "updated/deleted" must not cancel the new one
    const late = await send(event('customer.subscription.deleted', sub({ id: oldSub, customer: cus, status: 'canceled' })));
    expect((await json(late)).data).toMatchObject({ ignored: 'stale subscription' });
    expect(await row(biz.id)).toMatchObject({ billingStatus: 'active', stripeSubscriptionId: newSub });
  });

  test('a failure while processing releases the claim so Stripe retry is processed (500 then 200)', async () => {
    const biz = await newBusiness();
    const ev = event('customer.subscription.created', sub({ id: uniq('sub'), customer: uniq('cus'), business: biz.id, status: 'active' }));
    // make the business row unwritable for a moment: a CHECK-violating status would be rejected by Postgres
    const original = db.setBillingState;
    expect(typeof original).toBe('function');
    await prisma.$executeRawUnsafe(`ALTER TABLE businesses ADD CONSTRAINT tmp_block_${biz.id.replace(/\W/g, '')} CHECK (id <> '${biz.id}' OR billing_status <> 'active') NOT VALID`);
    try {
      const failed = await send(ev);
      expect(failed.status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE businesses DROP CONSTRAINT tmp_block_${biz.id.replace(/\W/g, '')}`);
    }
    const retry = await send(ev);
    expect(retry.status).toBe(200);
    expect((await json(retry)).data).toMatchObject({ business_id: biz.id });
    expect((await row(biz.id)).billingStatus).toBe('active');
  });
});
