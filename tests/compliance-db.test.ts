/** DB-backed send-path test; runs only with TEST_DATABASE_URL (see tests/db/db.test.ts). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
}
const suite = url ? describe : describe.skip;

suite('sendAndLog compliance policy (postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any, msg: typeof import('../src/lib/messaging');
  const ids: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ALLOW_INSECURE_DEV = 'true';
    delete process.env.TWILIO_ACCOUNT_SID;
    db = await import('../src/lib/db');
    msg = await import('../src/lib/messaging');
  });
  afterAll(async () => {
    await db.prisma.business.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.$disconnect();
  });

  test('opt-out blocks customer texts but not owner alerts; STOP footer; quiet hours; logging', async () => {
    const biz = await db.createBusiness({ name: 'Policy Test', owner_phone: '+13055550111' });
    ids.push(biz.id);
    const noon = new Date('2026-07-01T12:00:00-04:00');
    const night = new Date('2026-07-01T22:00:00-04:00');
    const cust = '+13055550222';

    const ok1 = await msg.sendAndLog({ business_id: biz.id, to: cust, body: 'Confirmed.', kind: 'confirmation', now: noon });
    expect(ok1.sms.body).toContain('Reply STOP to opt out');
    expect(ok1.sms.consent_basis).toBe('transactional_booking');

    const noBasis = await msg.sendAndLog({ business_id: biz.id, to: cust, body: 'How was it?', kind: 'gratitude', now: noon });
    expect(noBasis.blocked).toBe('blocked_no_consent');
    const quiet = await msg.sendAndLog({ business_id: biz.id, to: cust, body: 'How was it?', kind: 'gratitude', consent_basis: 'booking_followup', now: night });
    expect(quiet.blocked).toBe('blocked_quiet_hours');
    expect(quiet.sms.status).toBe('blocked_quiet_hours');

    await db.recordOptOut(biz.id, cust);
    const blocked = await msg.sendAndLog({ business_id: biz.id, to: cust, body: 'Confirmed.', kind: 'confirmation', now: noon });
    expect(blocked.blocked).toBe('blocked_opt_out');
    expect(blocked.sms.status).toBe('blocked_opt_out');

    const owner = await msg.sendAndLog({ business_id: biz.id, to: '+13055550111', body: 'EMERGENCY', kind: 'owner_alert', now: night });
    expect(owner.blocked).toBeUndefined();
    expect(owner.sms.consent_basis).toBe('owner_alert');
    expect(owner.sms.body).toBe('EMERGENCY');
  });
});
