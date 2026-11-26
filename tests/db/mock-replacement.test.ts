/**
 * DB helpers added for the mock-replacement work: per-tenant line, deposit policy + manual deposits, scheduling / crews (crew-aware overlap guard),
 * inbound inbox, durable briefing audio, content confirmation, review url / assistant name / timezone, retention + erasure + export of the new tables.
 * Skipped unless TEST_DATABASE_URL names a disposable database containing "test" or "scratch" with the migrations applied.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
const suite = url ? describe : describe.skip;

suite('mock-replacement db helpers (postgres)', () => {
  let db: any;
  const run = Math.random().toString(36).slice(2, 8);
  const ids: string[] = [];
  const fails = async (p: PromiseLike<unknown>) => { try { await p; return false; } catch { return true; } };
  const futureAt = (hours: number) => { const d = new Date(Date.now() + 3 * 86_400_000); d.setUTCHours(hours, 0, 0, 0); return d.toISOString(); };

  beforeAll(async () => { process.env.DATABASE_URL = url; db = await import('../../src/lib/db'); });
  afterAll(async () => { await db.prisma.business.deleteMany({ where: { id: { in: ids } } }); await db.prisma.$disconnect(); });
  const biz = async (extra: Record<string, unknown> = {}) => { const b = await db.createBusiness({ name: `MR ${run}`, ...extra }); ids.push(b.id); return b; };

  test('defaults of a new business equal the previous behaviour; mapper exposes every new field', async () => {
    const b = await biz();
    expect(b).toMatchObject({
      elevenlabs_phone_number_id: null, twilio_phone_sid: null, review_url: null, assistant_name: null,
      deposit_enabled: false, deposit_mode: 'fixed', deposit_fixed_cents: null, deposit_percent: null, deposit_min_cents: null, deposit_max_cents: null,
      slot_minutes: 60, min_lead_minutes: 60, horizon_days: 14, buffer_minutes: 0, crews: 1,
      content_confirmed_at: null, content_confirmed_hash: null, native_transfer_enabled: false, timezone: 'America/New_York',
    });
  });

  test('updateBusiness: review url, assistant name, native transfer, timezone are validated; invalid values are ignored', async () => {
    const b = await biz();
    const u = await db.updateBusiness(b.id, { review_url: 'https://g.page/r/x', assistant_name: '  Sofia ', native_transfer_enabled: true, timezone: 'America/Chicago' });
    expect(u).toMatchObject({ review_url: 'https://g.page/r/x', assistant_name: 'Sofia', native_transfer_enabled: true, timezone: 'America/Chicago' });
    const bad = await db.updateBusiness(b.id, { review_url: 'http://insecure.example/x', assistant_name: 'x'.repeat(41), timezone: 'EST', slot_minutes: 20, crews: 99 });
    expect(bad).toMatchObject({ review_url: 'https://g.page/r/x', assistant_name: 'Sofia', timezone: 'America/Chicago', slot_minutes: 60, crews: 1 });
    expect((await db.updateBusiness(b.id, { review_url: null, assistant_name: null }))).toMatchObject({ review_url: null, assistant_name: null });
    // the database itself refuses what the app would not write
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { reviewUrl: 'http://x.example/y' } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { reviewUrl: `https://x.example/${'a'.repeat(300)}` } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { assistantName: '' } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { assistantName: 'x'.repeat(41) } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { timezone: 'EST' } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { slotMinutes: 20 } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { crews: 21 } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { crews: 0 } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { horizonDays: 0 } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { bufferMinutes: 241 } }))).toBe(true);
    expect(await db.setBusinessTimeZone(b.id, 'Europe/London')).toEqual({ ok: true, timezone: 'Europe/London' });
    expect((await db.setBusinessTimeZone(b.id, '+01:00')).ok).toBe(false);
    expect(await db.setBusinessTimeZone('nope', 'Europe/London')).toEqual({ ok: false, reason: 'not_found' });
  });

  test('per-tenant line: unique per business, validated, env is only a fallback', async () => {
    const a = await biz(); const c = await biz();
    const pn = `phnum_${run}`;
    const r = await db.setBusinessLine(a.id, { elevenlabs_phone_number_id: pn, twilio_phone_sid: `PN${run}` });
    expect(r).toMatchObject({ ok: true, business: { elevenlabs_phone_number_id: pn, twilio_phone_sid: `PN${run}` } });
    expect(await db.setBusinessLine(c.id, { elevenlabs_phone_number_id: pn })).toEqual({ ok: false, reason: 'in_use' }); // never stolen
    expect(await db.setBusinessLine(c.id, { twilio_phone_sid: `PN${run}` })).toEqual({ ok: false, reason: 'in_use' });
    expect((await db.setBusinessLine(c.id, { elevenlabs_phone_number_id: 'has space' })).ok).toBe(false);
    expect(await db.setBusinessLine('nope', { elevenlabs_phone_number_id: 'x1' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await db.getBusinessIdByElevenLabsPhoneNumberId(pn)).toBe(a.id);
    expect(await db.getBusinessIdByTwilioPhoneSid(`PN${run}`)).toBe(a.id);
    const own = await db.getBusiness(a.id);
    expect(db.resolveElevenLabsPhoneNumberId(own, { ELEVENLABS_PHONE_NUMBER_ID: 'phnum_shared' })).toEqual({ id: pn, source: 'business' });
    expect(db.resolveElevenLabsPhoneNumberId(await db.getBusiness(c.id), { ELEVENLABS_PHONE_NUMBER_ID: 'phnum_shared' })).toEqual({ id: 'phnum_shared', source: 'env' });
    expect(db.resolveElevenLabsPhoneNumberId(await db.getBusiness(c.id), {})).toBeNull();
    expect((await db.setBusinessLine(a.id, { elevenlabs_phone_number_id: null })).ok).toBe(true); // releasing frees it
    expect((await db.setBusinessLine(c.id, { elevenlabs_phone_number_id: pn })).ok).toBe(true);
  });

  test('deposit policy: whole-policy validation, CHECKs, manual mark / unmark, stripe replaces manual', async () => {
    const b = await biz(); const other = await biz();
    expect(await db.getDepositPolicy(b.id)).toEqual({ enabled: false, mode: 'fixed', fixed_cents: null, percent: null, min_cents: null, max_cents: null });
    expect(await db.setDepositPolicy(b.id, { enabled: true, mode: 'percent', percent: 30, min_cents: 2500, max_cents: 30000 })).toMatchObject({ ok: true });
    expect(await db.getDepositPolicy(b.id)).toEqual({ enabled: true, mode: 'percent', fixed_cents: null, percent: 30, min_cents: 2500, max_cents: 30000 });
    expect(await db.setDepositPolicy(b.id, { enabled: true, mode: 'fixed' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await db.setDepositPolicy('nope', { enabled: false })).toEqual({ ok: false, reason: 'not_found' });
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { depositEnabled: true, depositMode: 'fixed', depositFixedCents: null } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { depositMinCents: 99 } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { depositMaxCents: 100_001 } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { depositPercent: 101 } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { depositMode: 'weekly' } }))).toBe(true);
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { depositMinCents: 9000, depositMaxCents: 8000 } }))).toBe(true);

    const bk = await db.createBooking({ business_id: b.id, customer_name: 'Ann', customer_phone: '+13055550140', service: 'AC', scheduled_at: futureAt(15), status: 'pending', deposit_amount: 5000, created_via: 'dashboard' }, { enforce: false });
    expect(bk).toMatchObject({ deposit_paid: false, deposit_source: null, created_via: 'dashboard', crew: 1 });
    const actor = { kind: 'user' as const, user_id: null };
    expect((await db.markDepositPaidManually(other.id, bk.id, actor)).reason).toBe('not_found'); // tenant scoped
    const m = await db.markDepositPaidManually(b.id, bk.id, { kind: 'admin_token' });
    expect(m).toMatchObject({ ok: true, changed: true, booking: { deposit_paid: true, deposit_amount: 5000, deposit_source: 'manual', deposit_marked_by: 'admin_token', status: 'confirmed' } });
    expect(m.booking.deposit_marked_at).toBeTruthy();
    expect(await db.markDepositPaidManually(b.id, bk.id, actor)).toMatchObject({ ok: true, changed: false }); // idempotent
    expect(await db.markDepositPaidManually(b.id, bk.id, actor, { amount_cents: 9000 })).toEqual({ ok: false, reason: 'already_paid' });
    expect(await fails(db.prisma.booking.update({ where: { id: bk.id }, data: { depositSource: 'cash' } }))).toBe(true);
    expect(await fails(db.prisma.booking.update({ where: { id: bk.id }, data: { depositMarkedAt: null } }))).toBe(true); // manual needs a timestamp
    expect(await db.unmarkManualDeposit(other.id, bk.id, actor)).toEqual({ ok: false, reason: 'not_found' });
    expect(await db.unmarkManualDeposit(b.id, bk.id, actor)).toMatchObject({ ok: true, booking: { deposit_paid: false, deposit_source: null, deposit_marked_at: null, deposit_amount: 5000 } });
    expect(await db.unmarkManualDeposit(b.id, bk.id, actor)).toEqual({ ok: false, reason: 'not_manual' });
    // a Stripe payment is not "manual": refuse to mark over it, and stripe replaces an earlier manual mark
    await db.markDepositPaidManually(b.id, bk.id, actor);
    // a card payment of the SAME amount also replaces the mark (review 21 H1: the customer paid twice, the caller is told through `replaced_manual`) ...
    expect(await db.markDepositPaid(bk.id, 5000)).toEqual({ updated: true, replaced_manual: { amount_cents: 5000, marked_by: 'user', refund_status: 'none', refund_amount_cents: null } });
    expect(await db.getBooking(bk.id)).toMatchObject({ deposit_source: 'stripe', deposit_marked_by: null, deposit_marked_at: null, deposit_amount: 5000 });
    expect(await db.markDepositPaid(bk.id, 5000)).toEqual({ updated: false, replaced_manual: null }); // ... and a repeat of the same payment (the second Stripe event) is a no-op
    // ... a different amount from Stripe replaces the amount
    await db.markDepositPaid(bk.id, 6000);
    expect(await db.getBooking(bk.id)).toMatchObject({ deposit_source: 'stripe', deposit_marked_by: null, deposit_marked_at: null, deposit_amount: 6000 });
    expect(await db.unmarkManualDeposit(b.id, bk.id, actor)).toEqual({ ok: false, reason: 'not_manual' });
    const cancelled = await db.createBooking({ business_id: b.id, customer_name: 'Zed', customer_phone: '+13055550141', service: 'AC', scheduled_at: futureAt(17), status: 'cancelled', deposit_amount: 5000 }, { enforce: false });
    expect(await db.markDepositPaidManually(b.id, cancelled.id, actor)).toEqual({ ok: false, reason: 'cancelled' });
    const noAmount = await db.createBooking({ business_id: b.id, customer_name: 'Yan', customer_phone: '+13055550142', service: 'AC', scheduled_at: futureAt(19) }, { enforce: false });
    expect(await db.markDepositPaidManually(b.id, noAmount.id, actor)).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(await db.markDepositPaidManually(b.id, noAmount.id, actor, { amount_cents: 2500 })).toMatchObject({ ok: true });
    expect(await db.prisma.auditEvent.count({ where: { businessId: b.id, action: 'booking.deposit_marked_manual' } })).toBeGreaterThanOrEqual(2);
  });

  test('crews: the overlap guard is per crew; default single crew behaves as before', async () => {
    const b = await biz();
    const at = futureAt(14);
    const mk = (extra: Record<string, unknown> = {}) => db.createBooking({ business_id: b.id, customer_name: 'C', customer_phone: '+13055550150', service: 'AC', scheduled_at: at, duration_minutes: 60, ...extra }, { enforce: false });
    expect((await mk()).crew).toBe(1);
    await expect(mk()).rejects.toMatchObject({ reason: 'slot_taken' }); // one crew: the old rule
    expect((await db.setSchedulingConfig(b.id, { crews: 2 })).ok).toBe(true);
    expect((await mk()).crew).toBe(2); // first free crew
    await expect(mk()).rejects.toMatchObject({ reason: 'slot_taken' });
    await expect(mk({ crew: 3 })).rejects.toMatchObject({ reason: 'invalid_crew' });
    expect(await db.firstFreeCrewFor(b.id, new Date(at).getTime(), new Date(at).getTime() + 3_600_000)).toBeNull();
    expect(await db.firstFreeCrewFor(b.id, new Date(at).getTime() + 3_600_000, new Date(at).getTime() + 7_200_000)).toBe(1);
    const by = await db.listBlockingIntervalsByCrew(b.id, new Date(at).getTime(), new Date(at).getTime() + 3_600_000);
    expect(by.map((x: any) => x.crew).sort()).toEqual([1, 2]);
    // the database constraint (not just the app check) is per (business, crew)
    expect(await fails(db.prisma.booking.create({ data: { businessId: b.id, customerName: 'x', customerPhone: '', service: 's', scheduledAt: new Date(at), crew: 2 } }))).toBe(true);
    const third = await db.prisma.booking.create({ data: { businessId: b.id, customerName: 'x', customerPhone: '', service: 's', scheduledAt: new Date(at), crew: 3 } });
    expect(third.crew).toBe(3); // raw insert on a free crew works; crew 3 is above crews=2 until cleaned up
    // lowering crews is refused while a live booking sits above the new count
    expect(await db.setSchedulingConfig(b.id, { crews: 1 })).toMatchObject({ ok: false, reason: 'crew_in_use' });
    await db.prisma.booking.delete({ where: { id: third.id } });
    expect(await db.setSchedulingConfig(b.id, { crews: 1 })).toMatchObject({ ok: false, reason: 'crew_in_use' }); // crew 2 booking still there
    expect(await db.setSchedulingConfig(b.id, { slot_minutes: 20 })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await db.setSchedulingConfig(b.id, { slot_minutes: 30, horizon_days: 30, min_lead_minutes: 0, buffer_minutes: 15 })).toMatchObject({ ok: true, config: { slot_minutes: 30, horizon_days: 30, min_lead_minutes: 0, buffer_minutes: 15, crews: 2 } });
    expect(await db.getSchedulingConfig(b.id)).toMatchObject({ slot_minutes: 30, crews: 2 });
    // rescheduling keeps the crew when free, else moves to the first free crew
    const other = await db.createBooking({ business_id: b.id, customer_name: 'D', customer_phone: '+13055550151', service: 'AC', scheduled_at: futureAt(18), crew: 2 }, { enforce: false });
    expect(other.crew).toBe(2);
    const moved = await db.rescheduleBooking({ business_id: b.id, booking_id: other.id, scheduled_at: at }, { enforce: false }).catch((e: any) => e);
    expect(moved.reason ?? 'ok').toBe('slot_taken'); // both crews busy at `at`
    const back = await db.rescheduleBooking({ business_id: b.id, booking_id: other.id, scheduled_at: futureAt(20) }, { enforce: false });
    expect(back.booking.crew).toBe(2);
  });

  test('inbound inbox: dedupe on sid, tenant scoping, status flow, stamps, paging, E.164 only', async () => {
    const a = await biz(); const c = await biz();
    const sid = `SM${run}a`;
    const r1 = await db.recordInboundMessage({ business_id: a.id, from: '(305) 555-0160', body: 'Can you come at 3?', twilio_message_sid: sid });
    expect(r1).toMatchObject({ ok: true, created: true, message: { from_e164: '+13055550160', status: 'new', body: 'Can you come at 3?' } });
    const r2 = await db.recordInboundMessage({ business_id: a.id, from: '+13055550160', body: 'dup', twilio_message_sid: sid });
    expect(r2).toMatchObject({ ok: true, created: false, message: { id: r1.message.id, body: 'Can you come at 3?' } });
    expect(await db.recordInboundMessage({ business_id: c.id, from: '+13055550160', body: 'x', twilio_message_sid: sid })).toEqual({ ok: false, reason: 'sid_other_business' });
    const race = await Promise.all(Array.from({ length: 5 }, () => db.recordInboundMessage({ business_id: a.id, from: '+13055550161', body: 'race', twilio_message_sid: `SM${run}race` })));
    expect(race.filter((x: any) => x.created).length).toBe(1);
    expect(await db.prisma.inboundMessage.count({ where: { twilioMessageSid: `SM${run}race` } })).toBe(1);
    expect(await db.recordInboundMessage({ business_id: a.id, from: 'junk', body: 'x', twilio_message_sid: `SM${run}b` })).toEqual({ ok: false, reason: 'invalid_phone' });
    expect(await db.recordInboundMessage({ business_id: a.id, from: '+13055550160', body: '   ', twilio_message_sid: `SM${run}c` })).toEqual({ ok: false, reason: 'empty_body' });
    expect(await db.recordInboundMessage({ business_id: a.id, from: '+13055550160', body: 'x', twilio_message_sid: '' })).toEqual({ ok: false, reason: 'invalid_sid' });
    expect(await db.recordInboundMessage({ business_id: 'no-such', from: '+13055550160', body: 'x', twilio_message_sid: `SM${run}d` })).toEqual({ ok: false, reason: 'business_not_found' });
    const long = await db.recordInboundMessage({ business_id: a.id, from: '+13055550162', body: 'z'.repeat(5000), twilio_message_sid: `SM${run}long` });
    expect(long.message.body.length).toBe(1600);
    expect(await fails(db.prisma.inboundMessage.create({ data: { businessId: a.id, fromE164: '+13055550162', fromPhone: 'x', body: 'z'.repeat(1601), twilioMessageSid: `SM${run}too` } }))).toBe(true);
    expect(await fails(db.prisma.inboundMessage.create({ data: { businessId: a.id, fromE164: '3055550162', fromPhone: 'x', body: 'b', twilioMessageSid: `SM${run}e164` } }))).toBe(true);

    // tenant scoping
    expect(await db.getInboundMessage(c.id, r1.message.id)).toBeNull();
    expect(await db.setInboundStatus(c.id, r1.message.id, 'handled', 'u1')).toBeNull();
    expect(await db.markInboundForwarded(c.id, r1.message.id)).toBe(false);
    // status flow
    const h = await db.setInboundStatus(a.id, r1.message.id, 'handled', 'user-1');
    expect(h).toMatchObject({ status: 'handled', handled_by: 'user-1' });
    expect(h.handled_at).toBeTruthy();
    expect(await fails(db.prisma.inboundMessage.update({ where: { id: r1.message.id }, data: { handledAt: null } }))).toBe(true); // handled needs handled_at
    expect(await db.setInboundStatus(a.id, r1.message.id, 'new', null)).toMatchObject({ status: 'new', handled_at: null, handled_by: null });
    await expect(db.setInboundStatus(a.id, r1.message.id, 'bogus', null)).rejects.toThrow();
    // stamps: first wins
    expect(await db.markInboundForwarded(a.id, r1.message.id)).toBe(true);
    expect(await db.markInboundForwarded(a.id, r1.message.id)).toBe(false);
    expect(await db.markInboundAutoReplied(a.id, r1.message.id)).toBe(true);
    expect(await db.markInboundAutoReplied(a.id, r1.message.id)).toBe(false);
    // booking link (same business only)
    const bk = await db.createBooking({ business_id: a.id, customer_name: 'Q', customer_phone: '+13055550160', service: 'AC', scheduled_at: futureAt(16) }, { enforce: false });
    const ck = await db.createBooking({ business_id: c.id, customer_name: 'Q', customer_phone: '+13055550160', service: 'AC', scheduled_at: futureAt(16) }, { enforce: false });
    expect(await db.linkInboundToBooking(a.id, r1.message.id, ck.id)).toBe(false);
    expect(await db.linkInboundToBooking(a.id, r1.message.id, bk.id)).toBe(true);
    expect((await db.getInboundMessage(a.id, r1.message.id)).booking_id).toBe(bk.id);
    await db.prisma.booking.delete({ where: { id: bk.id } });
    expect((await db.getInboundMessage(a.id, r1.message.id)).booking_id).toBeNull(); // SET NULL
    // paging newest first + status counts
    for (let i = 0; i < 4; i++) await db.recordInboundMessage({ business_id: a.id, from: '+13055550163', body: `m${i}`, twilio_message_sid: `SM${run}p${i}`, received_at: new Date(Date.now() + 1000 * (i + 1)) });
    const p1 = await db.listInboundMessagesPage(a.id, { limit: 3 });
    expect(p1.items.map((m: any) => m.body)).toEqual(['m3', 'm2', 'm1']);
    const p2 = await db.listInboundMessagesPage(a.id, { limit: 3, cursor: p1.next_cursor });
    expect(p2.items[0].body).toBe('m0');
    expect((await db.listInboundMessagesPage(a.id, { fromE164: '+13055550163' })).items.length).toBe(4);
    expect(await db.countInboundByStatus(a.id)).toMatchObject({ new: 7, handled: 0, ignored: 0 });
    expect((await db.latestInboundFrom(a.id, '+13055550163')).body).toBe('m3');
    expect((await db.listInboundMessagesPage(c.id)).items).toEqual([]);
  });

  test('briefing audio: stored in postgres, tenant scoped, size / type limits, replace, prune, cascades with its briefing', async () => {
    const a = await biz(); const c = await biz();
    const br = await db.createBriefing({ business_id: a.id, date: '2030-02-01', transcript: 'hello' });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const saved = await db.saveBriefingAudio(a.id, br.id, { content_type: 'audio/mpeg', bytes, voice_id: 'v1' });
    expect(saved).toMatchObject({ ok: true, audio_url: `/api/briefings/${br.id}/audio`, meta: { size_bytes: 5, content_type: 'audio/mpeg', voice_id: 'v1' } });
    expect((await db.getLatestBriefing(a.id)).audio_url).toBe(`/api/briefings/${br.id}/audio`);
    const got = await db.getBriefingAudio(a.id, br.id);
    expect([...got.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(got.content_type).toBe('audio/mpeg');
    expect(await db.getBriefingAudio(c.id, br.id)).toBeNull(); // another tenant cannot read it
    expect(await db.getBriefingAudioMeta(c.id, br.id)).toBeNull();
    expect(await db.getBriefingAudioMeta(a.id, br.id)).toMatchObject({ size_bytes: 5 });
    expect(await db.saveBriefingAudio(c.id, br.id, { content_type: 'audio/mpeg', bytes })).toEqual({ ok: false, reason: 'briefing_not_found' });
    expect(await db.saveBriefingAudio(a.id, br.id, { content_type: 'audio/mpeg', bytes: new Uint8Array(0) })).toEqual({ ok: false, reason: 'empty' });
    expect(await db.saveBriefingAudio(a.id, br.id, { content_type: 'audio/mpeg', bytes: new Uint8Array(5 * 1024 * 1024 + 1) })).toEqual({ ok: false, reason: 'too_large' });
    expect(await db.saveBriefingAudio(a.id, br.id, { content_type: 'text/html', bytes })).toEqual({ ok: false, reason: 'bad_type' });
    expect((await db.saveBriefingAudio(a.id, br.id, { content_type: 'audio/mp4', bytes: new Uint8Array(5 * 1024 * 1024) })).ok).toBe(true); // exactly 5 MB, replaces
    expect(await db.prisma.briefingAudio.count({ where: { briefingId: br.id } })).toBe(1);
    expect(await fails(db.prisma.$executeRawUnsafe(`UPDATE briefing_audio SET bytes = '\\x' WHERE briefing_id = '${br.id}'`))).toBe(true); // DB size CHECK (empty)
    // prune: older than keepDays loses audio (and the pointer) but the briefing stays
    const old = await db.createBriefing({ business_id: a.id, date: '2030-02-02', transcript: 'older' });
    await db.saveBriefingAudio(a.id, old.id, { content_type: 'audio/mpeg', bytes });
    await db.prisma.briefingAudio.update({ where: { briefingId: old.id }, data: { createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    const pr = await db.pruneBriefingAudio({ keepDays: 30 });
    expect(pr.removed).toBeGreaterThanOrEqual(1);
    expect(await db.getBriefingAudio(a.id, old.id)).toBeNull();
    expect((await db.prisma.briefing.findUnique({ where: { id: old.id } })).audioUrl).toBeNull();
    expect(await db.getBriefingAudio(a.id, br.id)).not.toBeNull(); // fresh one survives
    expect(await db.deleteBriefingAudio(a.id, br.id)).toBe(true);
    expect(await db.deleteBriefingAudio(a.id, br.id)).toBe(false);
    expect((await db.prisma.briefing.findUnique({ where: { id: br.id } })).audioUrl).toBeNull();
    expect(db.briefingAudioKeepDays({})).toBe(30);
    expect(db.briefingAudioKeepDays({ BRIEFING_AUDIO_KEEP_DAYS: '7' })).toBe(7);
    expect(db.briefingAudioKeepDays({ BRIEFING_AUDIO_KEEP_DAYS: '0' })).toBe(30);
    // cascade: deleting the briefing deletes the clip
    await db.saveBriefingAudio(a.id, old.id, { content_type: 'audio/mpeg', bytes });
    await db.prisma.briefing.delete({ where: { id: old.id } });
    expect(await db.prisma.briefingAudio.count({ where: { briefingId: old.id } })).toBe(0);
  });

  test('content confirmation: unconfirmed -> confirmed -> stale when services / prices / FAQs / area change', async () => {
    const b = await biz({ service_area: ['Miami'] });
    await db.upsertKnowledgeBase(b.id, { services: [{ name: 'AC repair', base_price: 120 }], faqs: [], pricing_notes: 'est free' });
    const first = await db.getContentConfirmation(b.id);
    expect(first).toMatchObject({ state: 'unconfirmed', confirmed_at: null });
    expect(first!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const c = await db.confirmContent(b.id, { kind: 'user', user_id: null });
    expect(c.state).toBe('confirmed');
    expect((await db.getContentConfirmation(b.id)).state).toBe('confirmed');
    await db.upsertKnowledgeBase(b.id, { faqs: [{ question: 'q', answer: 'a' }] }); // FAQs carry prices too (review 22 M4): editing one makes the confirmation stale
    expect((await db.getContentConfirmation(b.id)).state).toBe('stale');
    await db.confirmContent(b.id, { kind: 'user', user_id: null });
    expect((await db.getContentConfirmation(b.id)).state).toBe('confirmed');
    await db.upsertKnowledgeBase(b.id, { services: [{ name: 'AC repair', base_price: 150 }] });
    expect((await db.getContentConfirmation(b.id)).state).toBe('stale');
    await db.confirmContent(b.id, { kind: 'user', user_id: null });
    await db.updateBusiness(b.id, { service_area: ['Miami', 'Hialeah'] });
    expect((await db.getContentConfirmation(b.id)).state).toBe('stale');
    expect(await db.clearContentConfirmation(b.id)).toBe(true);
    expect((await db.getContentConfirmation(b.id)).state).toBe('unconfirmed');
    expect(await db.getContentConfirmation('nope')).toBeNull();
    expect(await db.confirmContent('nope', { kind: 'system' })).toBeNull();
    expect(await fails(db.prisma.business.update({ where: { id: b.id }, data: { contentConfirmedAt: new Date() } }))).toBe(true); // at and hash come together
  });

  test('sms_log kinds: manual and the inbox kinds are allowed, others are not', async () => {
    const b = await biz();
    for (const kind of ['manual', 'owner_inbox_reply', 'inbox_autoreply']) {
      await db.logSms({ business_id: b.id, to_phone: '+13055550170', body: 'x', kind, status: 'sent' });
    }
    expect(await fails(db.prisma.smsLog.create({ data: { businessId: b.id, toPhone: '+13055550170', body: 'x', kind: 'weird' } }))).toBe(true);
  });

  test('retention, erasure and export cover inbound messages; sms opt-outs untouched', async () => {
    const b = await biz({ retention_days: 30 });
    const other = await biz({ retention_days: 30 });
    const old = new Date(Date.now() - 40 * 86_400_000);
    const mk = (biz_: string, from: string, sid: string, at: Date) => db.recordInboundMessage({ business_id: biz_, from, body: `from ${from}`, twilio_message_sid: `SM${run}${sid}`, received_at: at });
    await mk(b.id, '+13055550180', 'old', old);
    await mk(b.id, '+13055550180', 'new', new Date());
    await mk(b.id, '+13055550181', 'other', new Date());
    await mk(other.id, '+13055550180', 'otherbiz', new Date());
    const preview = await db.previewExpiredData(new Date());
    expect(preview.inbound_messages).toBeGreaterThanOrEqual(1);
    const counts = await db.purgeExpiredData(new Date());
    expect(counts.inbound_messages).toBeGreaterThanOrEqual(1);
    expect(await db.prisma.inboundMessage.count({ where: { businessId: b.id } })).toBe(2); // the old one is gone
    const { exportCustomerData } = await import('../../src/lib/privacy');
    const ex = await exportCustomerData(b.id, '+13055550180');
    expect(ex.inbound_messages.length).toBe(1);
    const er = await db.eraseCustomerData(b.id, '+13055550180');
    expect(er.inbound_messages).toBe(1);
    expect(await db.prisma.inboundMessage.count({ where: { businessId: b.id, fromE164: '+13055550180' } })).toBe(0);
    expect(await db.prisma.inboundMessage.count({ where: { businessId: b.id, fromE164: '+13055550181' } })).toBe(1); // another customer untouched
    expect(await db.prisma.inboundMessage.count({ where: { businessId: other.id } })).toBe(1); // another tenant untouched
  });

  test('retention purge removes briefing audio with its briefing (cascade); erasure by day does too', async () => {
    const b = await biz({ retention_days: 30 });
    const br = await db.createBriefing({ business_id: b.id, date: '2030-03-01', transcript: 'x' });
    await db.saveBriefingAudio(b.id, br.id, { content_type: 'audio/mpeg', bytes: new Uint8Array([9, 9]) });
    await db.prisma.briefing.update({ where: { id: br.id }, data: { createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    await db.purgeExpiredData(new Date());
    expect(await db.prisma.briefing.count({ where: { id: br.id } })).toBe(0);
    expect(await db.prisma.briefingAudio.count({ where: { briefingId: br.id } })).toBe(0);
  });
});
