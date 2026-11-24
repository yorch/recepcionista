/**
 * F3 (docs/review/08): cap-exempt owner alerts (flag_emergency, handoff_to_human) cannot be pumped. Alerts are length-limited and
 * GSM-safe, identical alerts for one call are sent once, the hourly OWNER_ALERT_HOURLY_LIMIT budget (separate from the SMS plan
 * cap) bounds them, and the FIRST emergency of a call is never starved by the budget (up to a hard ceiling).
 */
import { integration, withEnv } from '../helpers/env';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';
import { alertField, clampAlertBody, emergencyCeiling, OWNER_ALERT_MAX_CHARS, ownerAlertHourlyLimit } from '../../src/lib/voice/owner-alert';
import { isGsm7, smsSegments } from '../../src/lib/messaging/policy';

describe('clampAlertBody (pure)', () => {
  test('caps at 320 characters and septets, ends with "...", and stays within 3 GSM segments', () => {
    const out = clampAlertBody(`EMERGENCY\nReason: ${'x'.repeat(1500)}`);
    expect(out.length).toBeLessThanOrEqual(OWNER_ALERT_MAX_CHARS);
    expect(out.endsWith('...')).toBe(true);
    expect(smsSegments(out)).toBeLessThanOrEqual(3);
    // two-septet characters count double toward the cap
    const ext = clampAlertBody('{'.repeat(1000));
    expect(smsSegments(ext)).toBeLessThanOrEqual(3);
    expect([...ext].reduce((n, c) => n + (c === '{' ? 2 : 1), 0)).toBeLessThanOrEqual(OWNER_ALERT_MAX_CHARS);
  });
  test('is GSM-safe: dashes, quotes, accents and emoji never flip the text to UCS-2', () => {
    const out = clampAlertBody('EMERGENCY — Café “La María”: huele a gas, áíóú 😀 …\u0007 ok');
    expect(isGsm7(out)).toBe(true);
    expect(out).toContain('EMERGENCY - ');
    expect(out).toContain('"La Mar');
    expect(out).toContain('aiou');
    expect(out).not.toContain('\u0007');
    expect(out).toContain('?'); // the emoji
    expect(clampAlertBody('short alert')).toBe('short alert');
  });
  test('alertField keeps one field short and single-line', () => {
    expect(alertField('  a\n\n b   c ', 10)).toBe('a b c');
    expect(alertField('y'.repeat(500), 40).length).toBe(40);
    expect(alertField('y'.repeat(500), 40).endsWith('...')).toBe(true);
  });
  test('OWNER_ALERT_HOURLY_LIMIT: default 6, positive integers only', () => {
    expect(ownerAlertHourlyLimit({} as NodeJS.ProcessEnv)).toBe(6);
    expect(ownerAlertHourlyLimit({ OWNER_ALERT_HOURLY_LIMIT: '3' } as unknown as NodeJS.ProcessEnv)).toBe(3);
    for (const bad of ['0', '-2', 'abc', '2.5', '']) expect(ownerAlertHourlyLimit({ OWNER_ALERT_HOURLY_LIMIT: bad } as unknown as NodeJS.ProcessEnv)).toBe(6);
    expect(emergencyCeiling(6)).toBe(12);
  });
});

integration('owner alerts: budget, dedupe, first emergency (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let tools: typeof import('@/lib/voice/tools');

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    tools = await import('@/lib/voice/tools');
  });
  afterAll(cleanup);

  const texts = (id: string) => prisma.smsLog.findMany({ where: { businessId: id, kind: 'owner_alert', status: { in: ['sent', 'mock'] } } });
  async function biz() {
    const b = await newBusiness();
    await prisma.business.update({ where: { id: b.id }, data: { billingStatus: 'active', smsCapOverride: 5 } });
    return b;
  }
  const quiet = async <T,>(fn: () => Promise<T>) => { const o = console.log; console.log = () => undefined; try { return await fn(); } finally { console.log = o; } };

  test('the repro: 10 emergencies with a 1500-char reason, cap 5: every text is <= 320 chars / 3 segments, and the total is bounded by the alert ceiling', async () => {
    await withEnv({ DEMO_MODE: 'true', BILLING_ENFORCED: 'true', OWNER_ALERT_HOURLY_LIMIT: '2' }, async () => {
      const b = await biz();
      await quiet(async () => { for (let i = 0; i < 10; i++) await tools.flagEmergency({ business_id: b.id, conversation_id: uniq('c'), reason: 'x'.repeat(1500) }); });
      const rows = await texts(b.id);
      expect(rows.length).toBeLessThanOrEqual(emergencyCeiling(2)); // 4: bounded, not 10
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        expect(r.body.length).toBeLessThanOrEqual(OWNER_ALERT_MAX_CHARS);
        expect(smsSegments(r.body)).toBeLessThanOrEqual(3);
        expect(isGsm7(r.body)).toBe(true);
      }
      expect((await db.getUsage(b.id))!.sms_count).toBeLessThanOrEqual(rows.length * 3);
    });
  });

  test('identical alerts for one call are sent once; both tool results stay honest (notified)', async () => {
    await withEnv({ DEMO_MODE: 'true' }, async () => {
      const b = await biz();
      const conv = uniq('c');
      const first = await quiet(() => tools.flagEmergency({ business_id: b.id, conversation_id: conv, reason: 'gas smell', customer_name: 'Ana' }));
      const again = await quiet(() => tools.flagEmergency({ business_id: b.id, conversation_id: conv, reason: 'gas smell', customer_name: 'Ana' }));
      expect(first.ok).toBe(true);
      expect(again.ok).toBe(true);
      expect((await texts(b.id)).length).toBe(1);
    });
  });

  test('handoffs are limited per hour; an honest "could not reach" result once the budget is spent', async () => {
    await withEnv({ DEMO_MODE: 'true', OWNER_ALERT_HOURLY_LIMIT: '3' }, async () => {
      const b = await biz();
      const results = [];
      for (let i = 0; i < 8; i++) results.push(await quiet(() => tools.handoffToHuman({ business_id: b.id, conversation_id: uniq('c'), reason: `please call me ${i}` })));
      const ok = results.filter((r) => r.ok).length;
      expect(ok).toBe(3);
      const refused = results.find((r) => !r.ok)!;
      expect((refused.data as { owner_notified: boolean; notify_failure?: string }).owner_notified).toBe(false);
      expect((refused.data as { notify_failure?: string }).notify_failure).toBe('rate_limited');
      expect((await texts(b.id)).length).toBe(3);
    });
  });

  test('the FIRST emergency of a call is never blocked by a spent budget; a repeat on the same call is', async () => {
    await withEnv({ DEMO_MODE: 'true', OWNER_ALERT_HOURLY_LIMIT: '2' }, async () => {
      const b = await biz();
      for (let i = 0; i < 6; i++) await quiet(() => tools.handoffToHuman({ business_id: b.id, conversation_id: uniq('c'), reason: `h${i}` })); // budget gone
      expect((await texts(b.id)).length).toBe(2);
      const conv = uniq('c');
      const urgent = await quiet(() => tools.flagEmergency({ business_id: b.id, conversation_id: conv, reason: 'gas smell' }));
      expect(urgent.ok).toBe(true); // first emergency of this call goes through
      const repeat = await quiet(() => tools.flagEmergency({ business_id: b.id, conversation_id: conv, reason: 'still a gas smell, please hurry' }));
      expect(repeat.ok).toBe(false); // second, different alert on the same call: over budget
      expect((repeat.data as { notify_failure?: string }).notify_failure).toBe('rate_limited');
      expect((await texts(b.id)).length).toBe(3);
    });
  });

  test('the budget is per business', async () => {
    await withEnv({ DEMO_MODE: 'true', OWNER_ALERT_HOURLY_LIMIT: '1' }, async () => {
      const a = await biz();
      const c = await biz();
      for (const x of [a, c]) {
        expect((await quiet(() => tools.handoffToHuman({ business_id: x.id, conversation_id: uniq('c'), reason: 'one' }))).ok).toBe(true);
        expect((await quiet(() => tools.handoffToHuman({ business_id: x.id, conversation_id: uniq('c'), reason: 'two' }))).ok).toBe(false);
      }
    });
  });
});
