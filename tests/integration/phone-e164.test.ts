/**
 * E.164 identity everywhere: dual-write of the e164 columns, exact E.164 matching, and the legacy last-10-digit
 * fallback that is only allowed between two US/Canada-shaped numbers (never across countries).
 */
import { integration } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';
import { toE164 } from '../../src/lib/phone';

// +1 207 946 0958 (Maine) and +44 20 7946 0958 (London) share their last ten digits.
const US = '+12079460958';
const UK = '+442079460958';

integration('phone E.164 identity (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
  });
  afterAll(cleanup);

  test('fixture numbers are valid and collide on their last ten digits', () => {
    expect(toE164(US)).toBe(US);
    expect(toE164(UK)).toBe(UK);
    expect(US.slice(-10)).toBe(UK.slice(-10));
  });

  test('dual-write: calls, bookings, sms_log and opt-outs store the E.164 (business country for numbers without +)', async () => {
    const biz = await newBusiness();
    const call = await db.createCall({ business_id: biz.id, caller_phone: '(305) 555-0142' });
    expect((await prisma.call.findUnique({ where: { id: call.id } }))?.callerE164).toBe('+13055550142');
    await db.updateCall(call.id, { caller_phone: UK });
    expect((await prisma.call.findUnique({ where: { id: call.id } }))?.callerE164).toBe(UK);

    const when = new Date(Date.now() + 5 * 86400_000).toISOString();
    const booking = await db.createBooking({
      business_id: biz.id, customer_name: 'Ana', customer_phone: '305-555-0143', service: 'AC repair', scheduled_at: when,
    }, { enforce: false });
    expect((await prisma.booking.findUnique({ where: { id: booking.id } }))?.phoneE164).toBe('+13055550143');
    await db.updateBooking(booking.id, { customer_phone: UK });
    expect((await prisma.booking.findUnique({ where: { id: booking.id } }))?.phoneE164).toBe(UK);

    const sms = await db.logSms({ business_id: biz.id, to_phone: '3055550144', body: 'x', kind: 'other', status: 'sent' });
    expect((await prisma.smsLog.findUnique({ where: { id: sms.id } }))?.toE164).toBe('+13055550144');

    await db.recordOptOut(biz.id, '305 555 0145');
    const row = await prisma.smsOptOut.findFirst({ where: { businessId: biz.id } });
    expect(row?.phoneE164).toBe('+13055550145');
    expect(row?.phoneKey).toBe('3055550145');
    await db.recordOptOut(biz.id, UK);
    expect((await prisma.smsOptOut.findFirst({ where: { businessId: biz.id, phoneE164: UK } }))?.phoneKey).toBe(UK); // non-NANP key is the E.164

    // anonymising a booking drops its E.164 too
    await db.eraseCustomerData(biz.id, UK);
    const erased = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(erased?.anonymizedAt).not.toBeNull();
    expect(erased?.phoneE164).toBeNull();
  });

  test('opt-out of a +44 number never suppresses the +1 number with the same last ten digits, and vice versa', async () => {
    const a = await newBusiness();
    await db.recordOptOut(a.id, UK);
    expect(await db.isOptedOut(a.id, UK)).toBe(true);
    expect(await db.isOptedOut(a.id, US)).toBe(false);

    const b = await newBusiness();
    await db.recordOptOut(b.id, US);
    expect(await db.isOptedOut(b.id, US)).toBe(true);
    expect(await db.isOptedOut(b.id, UK)).toBe(false);
    expect(await db.isOptedOut(b.id, '(207) 946-0958')).toBe(true); // same number, local spelling

    // both can be suppressed at once (the unique key no longer conflates them)
    await db.recordOptOut(b.id, UK);
    expect(await db.isOptedOut(b.id, UK)).toBe(true);
    // START of one does not clear the other
    expect(await db.recordOptIn(b.id, UK)).toBe(true);
    expect(await db.isOptedOut(b.id, US)).toBe(true);
    expect(await db.isOptedOut(b.id, UK)).toBe(false);
  });

  test('legacy opt-out rows (no E.164) still suppress the matching US/CA number only', async () => {
    const biz = await newBusiness();
    await prisma.smsOptOut.create({ data: { businessId: biz.id, phoneKey: US.slice(-10), phoneE164: null, source: 'stop_keyword' } });
    expect(await db.isOptedOut(biz.id, US)).toBe(true);
    expect(await db.isOptedOut(biz.id, '2079460958')).toBe(true);
    expect(await db.isOptedOut(biz.id, UK)).toBe(false);
    // a new STOP for the same number upgrades the legacy row instead of duplicating it
    await db.recordOptOut(biz.id, US);
    const rows = await prisma.smsOptOut.findMany({ where: { businessId: biz.id } });
    expect(rows.length).toBe(1);
    expect(rows[0].phoneE164).toBe(US);
  });

  async function seedCustomer(businessId: string, phoneNumber: string, e164: string | null, tag: string) {
    const call = await prisma.call.create({
      data: { businessId, callerPhone: phoneNumber, callerE164: e164, callerName: null, status: 'completed', transcript: `t-${tag}` },
    });
    const booking = await prisma.booking.create({
      data: {
        businessId, customerName: `Cust ${tag}`, customerPhone: phoneNumber, phoneE164: e164, service: 'AC repair',
        scheduledAt: new Date(Date.now() + (tag === 'us' ? 10 : 20) * 86400_000), durationMinutes: 60,
      },
    });
    const sms = await prisma.smsLog.create({
      data: { businessId, toPhone: phoneNumber, toE164: e164, body: `hello ${tag}`, kind: 'confirmation', status: 'sent', bookingId: null },
    });
    return { call, booking, sms };
  }

  for (const legacy of [false, true]) {
    test(`erase / export are exact on E.164 (${legacy ? 'legacy rows without E.164' : 'dual-written rows'}): +44 never touches +1 and vice versa`, async () => {
      const biz = await newBusiness();
      const us = await seedCustomer(biz.id, legacy ? '(207) 946-0958' : US, legacy ? null : US, 'us');
      const uk = await seedCustomer(biz.id, legacy ? '+44 20 7946 0958' : UK, legacy ? null : UK, 'uk');

      const exportedUk = await (await import('../../src/lib/privacy')).exportCustomerData(biz.id, UK);
      expect((exportedUk.calls as { id: string }[]).map((c) => c.id)).toEqual(legacy ? [] : [uk.call.id]);
      if (legacy) {
        // a legacy +44 row (no E.164) is NOT served by the last-10 fallback for a +44 query: nothing is matched
        expect(exportedUk.bookings.length).toBe(0);
      }
      const exportedUs = await (await import('../../src/lib/privacy')).exportCustomerData(biz.id, US);
      expect((exportedUs.calls as { id: string }[]).map((c) => c.id)).toEqual([us.call.id]);
      expect((exportedUs.sms as { id: string }[]).map((c) => c.id)).toEqual([us.sms.id]);

      // erase the +44 customer: the +1 customer's rows all survive
      await db.eraseCustomerData(biz.id, UK);
      expect(await prisma.call.findUnique({ where: { id: us.call.id } })).not.toBeNull();
      expect(await prisma.smsLog.findUnique({ where: { id: us.sms.id } })).not.toBeNull();
      expect((await prisma.booking.findUnique({ where: { id: us.booking.id } }))?.anonymizedAt).toBeNull();
      if (!legacy) expect(await prisma.call.findUnique({ where: { id: uk.call.id } })).toBeNull();

      // erase the +1 customer: the +44 customer's rows survive (legacy +44 rows were never matched at all)
      await db.eraseCustomerData(biz.id, US);
      expect(await prisma.call.findUnique({ where: { id: us.call.id } })).toBeNull();
      expect((await prisma.booking.findUnique({ where: { id: us.booking.id } }))?.anonymizedAt).not.toBeNull();
      expect((await prisma.booking.findUnique({ where: { id: us.booking.id } }))?.phoneE164).toBeNull();
      const ukBooking = await prisma.booking.findUnique({ where: { id: uk.booking.id } });
      if (legacy) expect(ukBooking?.anonymizedAt).toBeNull(); // +44 legacy row: must not be erased by a +1 request
      expect((await prisma.smsLog.findUnique({ where: { id: uk.sms.id } })) === null).toBe(!legacy);
    });
  }

  test('sms bodies are matched by parsed number, so a +44 number in an owner alert is not the +1 customer', async () => {
    const biz = await newBusiness();
    const alertUk = await prisma.smsLog.create({
      data: { businessId: biz.id, toPhone: biz.owner_phone!, body: `HANDOFF\nPhone: ${UK}`, kind: 'owner_alert', status: 'sent' },
    });
    const alertUs = await prisma.smsLog.create({
      data: { businessId: biz.id, toPhone: biz.owner_phone!, body: 'HANDOFF\nPhone: (207) 946-0958', kind: 'owner_alert', status: 'sent' },
    });
    const { locateCustomerRecords, phoneIdent } = await import('../../src/lib/db/compliance');
    const us = await locateCustomerRecords(prisma, biz.id, phoneIdent(US), 'US');
    expect(us.smsIds).toEqual([alertUs.id]);
    const uk = await locateCustomerRecords(prisma, biz.id, phoneIdent(UK), 'US');
    expect(uk.smsIds).toEqual([alertUk.id]);
  });

  test('getBusinessByPhone: exact E.164 first; the legacy key serves US/CA numbers only', async () => {
    const usBiz = await db.createBusiness({ name: uniq('us'), phone: US });
    const ukBiz = await db.createBusiness({ name: uniq('uk'), phone: UK });
    expect((await db.getBusinessByPhone(US))?.id).toBe(usBiz.id);
    expect((await db.getBusinessByPhone(UK))?.id).toBe(ukBiz.id);
    expect((await db.getBusinessByPhone('(207) 946-0958'))?.id).toBe(usBiz.id);
    await prisma.business.deleteMany({ where: { id: { in: [usBiz.id, ukBiz.id] } } });

    // legacy business without E.164 (a +1 number only): reachable by +1, not by a +44 number with the same digits
    const legacy = await prisma.business.create({ data: { name: uniq('legacy'), phone: '2079460958', phoneKey: '2079460958', phoneE164: null } });
    expect((await db.getBusinessByPhone(US))?.id).toBe(legacy.id);
    expect(await db.getBusinessByPhone(UK)).toBeNull();
    await prisma.business.delete({ where: { id: legacy.id } });
  });
});
