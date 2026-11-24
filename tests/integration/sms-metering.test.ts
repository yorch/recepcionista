/** Caps count SMS segments (not sends), block a text that would not fit, and trials get the lower cap. */
import { integration, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, quietTimezone } from '../helpers/fixtures';
import { smsSegments, withStopFooter } from '../../src/lib/messaging/policy';

integration('sms metering in segments (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let messaging: typeof import('@/lib/messaging');

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    messaging = await import('@/lib/messaging');
  });
  afterAll(cleanup);

  const used = async (id: string) => (await db.getUsage(id))!.sms_count;
  const send = (id: string, body: string) => messaging.sendAndLog({ business_id: id, to: phone(), body, kind: 'confirmation' });
  async function biz(billingStatus: string, over: Record<string, unknown> = {}) {
    const b = await newBusiness();
    // Night in the business zone right now: outside quiet hours, crossing 80% / 100% of a cap texts the owner a usage warning that is metered too
    // (src/lib/billing/warnings.ts), which would add segments to the exact counts asserted here. Quiet hours defer it, whatever hour the suite runs at.
    await prisma.business.update({ where: { id: b.id }, data: { billingStatus, timezone: quietTimezone(), ...over } });
    return b;
  }

  test('a long text is metered as its real segments (footer included), not as one', async () => {
    const b = await biz('active');
    const body = 'a'.repeat(300);
    const expected = smsSegments(withStopFooter(body));
    expect(expected).toBeGreaterThanOrEqual(2);
    const res = await send(b.id, body);
    expect(res.blocked).toBeUndefined();
    expect(await used(b.id)).toBe(expected);
  });

  test('emoji / non-GSM text costs UCS-2 segments', async () => {
    const b = await biz('active');
    const body = `Hola, su cita está confirmada para mañana a las 9:00 😀 ${'x'.repeat(40)}`;
    const expected = smsSegments(withStopFooter(body));
    expect(smsSegments(body)).toBeGreaterThan(1);
    await send(b.id, body);
    expect(await used(b.id)).toBe(expected);
  });

  test('a text that would exceed the cap is blocked (blocked_cap), a smaller one that fits still goes', async () => {
    const b = await biz('active');
    await withEnv({ BILLING_ENFORCED: 'true', PLAN_SMS_CAP: '5' }, async () => {
      await db.recordSms(b.id, 4); // 1 segment left
      const twoSeg = 'b'.repeat(200); // 2 segments with the footer
      expect(smsSegments(withStopFooter(twoSeg))).toBe(2);
      const blocked = await send(b.id, twoSeg);
      expect(blocked.blocked).toBe('blocked_cap');
      expect(blocked.sms.status).toBe('blocked_cap');
      expect(await used(b.id)).toBe(4); // nothing was sent or counted

      const one = await send(b.id, 'Short text.');
      expect(one.blocked).toBeUndefined();
      expect(await used(b.id)).toBe(5);

      expect((await send(b.id, 'Another short one.')).blocked).toBe('blocked_cap'); // exactly at the cap now
    });
  });

  test('trialing: the lower TRIAL_SMS_CAP applies; an admin override wins; paid plans are unaffected', async () => {
    const trial = await biz('trialing');
    const paid = await biz('active');
    const overridden = await biz('trialing', { smsCapOverride: 100 });
    await withEnv({ BILLING_ENFORCED: 'true', PLAN_SMS_CAP: '500', TRIAL_SMS_CAP: '3' }, async () => {
      for (const id of [trial.id, paid.id, overridden.id]) await db.recordSms(id, 3);
      expect(await db.checkSmsAllowed(trial.id)).toEqual({ ok: false, reason: 'cap_reached', used: 3, cap: 3 });
      expect((await send(trial.id, 'Hello there.')).blocked).toBe('blocked_cap');
      expect((await db.checkSmsAllowed(paid.id)).ok).toBe(true);
      expect(await db.checkSmsAllowed(overridden.id)).toEqual({ ok: true, used: 3, cap: 100 });
      expect((await send(paid.id, 'Hello there.')).blocked).toBeUndefined();
    });
  });

  test('owner alerts are never blocked by the cap but ARE counted in segments', async () => {
    const b = await biz('active');
    await withEnv({ BILLING_ENFORCED: 'true', PLAN_SMS_CAP: '1' }, async () => {
      await db.recordSms(b.id, 1);
      const text = 'Emergency call: burst pipe at 12 Main St, caller needs a tech now. ' + 'z'.repeat(120);
      const res = await messaging.sendAndLog({ business_id: b.id, to: b.owner_phone!, body: text, kind: 'owner_alert' });
      expect(res.blocked).toBeUndefined();
      expect(await used(b.id)).toBe(1 + smsSegments(text));
    });
  });

  test('F2: the cap is reserved atomically: 20 concurrent sends with cap 5 / used 4 let exactly 1 through', async () => {
    const b = await biz('active', { smsCapOverride: 5 });
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      await db.recordSms(b.id, 4);
      const res = await Promise.all(Array.from({ length: 20 }, () => send(b.id, 'Hi')));
      const sent = res.filter((r) => !r.blocked);
      expect(sent.length).toBe(1);
      expect(res.filter((r) => r.blocked === 'blocked_cap').length).toBe(19);
      expect(await used(b.id)).toBe(5);
    });
  });

  test('F2: multi-segment sends reserve their whole size; many concurrent sends never exceed the cap', async () => {
    const b = await biz('active', { smsCapOverride: 10 });
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      const body = 'c'.repeat(200); // 2 segments with the footer
      const each = smsSegments(withStopFooter(body));
      const res = await Promise.all(Array.from({ length: 12 }, () => send(b.id, body)));
      const sent = res.filter((r) => !r.blocked).length;
      expect(sent).toBe(Math.floor(10 / each));
      expect(await used(b.id)).toBe(sent * each);
      expect(await used(b.id)).toBeLessThanOrEqual(10);
    });
  });

  test('F2: a failed send gives its reservation back', async () => {
    const b = await biz('active', { smsCapOverride: 5 });
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      const res = await messaging.sendAndLog({ business_id: b.id, to: '+999999999999999', body: 'Hi', kind: 'confirmation' });
      expect(res.result.status).toBe('failed');
      expect(await used(b.id)).toBe(0);
      expect((await send(b.id, 'Hi')).blocked).toBeUndefined();
      expect(await used(b.id)).toBe(1);
    });
  });

  test('F2: without enforcement the segments are still counted (no cap)', async () => {
    const b = await biz('active', { smsCapOverride: 1 });
    await withEnv({ BILLING_ENFORCED: 'false', NODE_ENV: 'test' }, async () => {
      await Promise.all([send(b.id, 'Hi'), send(b.id, 'Hi'), send(b.id, 'Hi')]);
      expect(await used(b.id)).toBe(3);
    });
  });
});
