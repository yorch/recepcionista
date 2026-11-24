/**
 * Phase-1 data layer against a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL names a database containing "test"/"scratch"
 * that already has the migrations applied): calendar, owner KB changes, live transcript, caller trust, usage warnings, passkeys,
 * memberships, locale/vertical/refund settings, reschedule + refunds. Every test uses its own rows and cleans up after itself.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
const suite = url ? describe : describe.skip;

const DAY = 86_400_000;
const HOURS = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { open: '06:00', close: '22:00' }]));
/** A UTC instant `days` from now at HH:MM (so the opening-hours check never depends on when the suite runs). */
/** Prisma queries are lazy thenables, not Promises: await them inside the helper so `rejects` works. */
const fails = async (p: PromiseLike<unknown>) => { let threw = false; try { await p; } catch { threw = true; } expect(threw).toBe(true); };
const at = (days: number, hh = 10, mm = 0) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(hh, mm, 0, 0); return d; };

suite('phase 1 data layer (postgres)', () => {
  let db: any, totp: any;
  const run = Math.random().toString(36).slice(2, 8);
  const businessIds: string[] = [];
  const userIds: string[] = [];
  const email = (n: string) => `${n}-${run}@example.test`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.APP_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
    db = await import('../../src/lib/db');
    totp = await import('../../src/lib/totp');
  });
  afterAll(async () => {
    await db.prisma.auditEvent.deleteMany({ where: { businessId: { in: businessIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.business.deleteMany({ where: { id: { in: businessIds } } });
    await db.prisma.$disconnect();
  });

  async function biz(extra: Record<string, unknown> = {}) {
    const b = await db.createBusiness({ name: `P1 ${run}`, timezone: 'UTC', hours: HOURS, ...extra });
    businessIds.push(b.id);
    return b;
  }
  async function user(name: string, role: 'owner' | 'staff' | 'admin', business_id?: string) {
    const u = await db.createUser({ email: email(name), password_hash: 'x', role, business_id: business_id ?? null, email_verified: true });
    userIds.push(u.id);
    return u;
  }

  // ── Google Calendar ────────────────────────────────────────────────────────
  describe('calendar', () => {
    const tokens = { access_token: 'ya29.ACCESS-secret', refresh_token: '1//REFRESH-secret' };
    const connect = (business_id: string, extra: Record<string, unknown> = {}) => db.upsertCalendarConnection({
      business_id, account_email: 'Owner@Example.com', ...tokens, token_expires_at: new Date(Date.now() + 3600_000), scopes: 'calendar.events', ...extra,
    });

    test('tokens are stored only encrypted, bound to the connection id, and readable only through getDecryptedTokens', async () => {
      const b = await biz();
      const c = await connect(b.id);
      expect(c).toMatchObject({ business_id: b.id, provider: 'google', account_email: 'owner@example.com', calendar_id: 'primary', status: 'active', has_refresh_token: true });
      expect(JSON.stringify(c)).not.toContain('secret');
      expect(Object.keys(c).some((k) => k.endsWith('_enc') || k === 'access_token' || k === 'refresh_token')).toBe(false);
      const raw = await db.prisma.calendarConnection.findUnique({ where: { id: c.id } });
      expect(raw.accessTokenEnc).toStartWith('v1.');
      expect(raw.refreshTokenEnc).toStartWith('v1.');
      expect(JSON.stringify(raw)).not.toContain('ACCESS-secret');
      expect(JSON.stringify(raw)).not.toContain('REFRESH-secret');
      expect(await db.getDecryptedTokens(c.id)).toMatchObject(tokens);
      expect(() => totp.decryptSecret(raw.accessTokenEnc, 'another-id')).toThrow(); // aad binds the envelope to this row
      expect(totp.decryptSecret(raw.accessTokenEnc, c.id)).toBe(tokens.access_token);
      expect(await db.getDecryptedTokens('nope')).toBeNull();
    });

    test('one connection per business; reconnecting keeps the id and the links, resets sync state and status', async () => {
      const b = await biz();
      const first = await connect(b.id);
      await db.updateCalendarSyncState(first.id, { sync_token: 'tok1', watch_channel_id: 'ch1', watch_resource_id: 'r1', watch_expires_at: new Date(Date.now() + DAY) });
      await db.setCalendarConnectionStatus(first.id, 'needs_reauth', 'invalid_grant');
      expect((await db.getCalendarConnection(b.id)).status).toBe('needs_reauth');
      const again = await connect(b.id, { access_token: 'ya29.NEW', refresh_token: '1//NEW', account_email: 'new@example.com' });
      expect(again.id).toBe(first.id);
      expect(again).toMatchObject({ status: 'active', sync_token: null, watch_channel_id: null, last_error: null, account_email: 'new@example.com' });
      expect(await db.getDecryptedTokens(first.id)).toMatchObject({ access_token: 'ya29.NEW', refresh_token: '1//NEW' });
      expect(await db.prisma.calendarConnection.count({ where: { businessId: b.id } })).toBe(1);
      // concurrent first-time connects converge on one row
      const b2 = await biz();
      const ids = await Promise.all(Array.from({ length: 6 }, () => connect(b2.id).then((x: any) => x.id)));
      expect(new Set(ids).size).toBe(1);
      expect(await db.getDecryptedTokens(ids[0])).toMatchObject(tokens); // the surviving envelope decrypts under the surviving id
    });

    test('updateCalendarTokens rotates tokens; revoking wipes them and the mirrored busy blocks', async () => {
      const b = await biz();
      const c = await connect(b.id);
      expect(await db.updateCalendarTokens(c.id, { access_token: 'ya29.ROTATED', token_expires_at: new Date(Date.now() + 1000) })).toBe(true);
      expect(await db.getDecryptedTokens(c.id)).toMatchObject({ access_token: 'ya29.ROTATED', refresh_token: tokens.refresh_token });
      await db.replaceBusyBlocks(c.id, [{ google_event_id: 'e1', starts_at: at(1), ends_at: at(1, 11) }]);
      expect(await db.setCalendarConnectionStatus(c.id, 'revoked', 'user disconnected')).toBe(true);
      const after = await db.getCalendarConnection(b.id);
      expect(after).toMatchObject({ status: 'revoked', has_refresh_token: false, sync_token: null, watch_channel_id: null });
      expect(await db.getDecryptedTokens(c.id)).toMatchObject({ access_token: null, refresh_token: null });
      expect(await db.listBusyBlocksInRange(b.id, at(0), at(3))).toEqual([]);
      expect(await db.setCalendarConnectionStatus('missing', 'error')).toBe(false);
      await expect(db.setCalendarConnectionStatus(c.id, 'bogus')).rejects.toThrow();
      // the active-needs-refresh-token CHECK
      await fails(db.prisma.calendarConnection.update({ where: { id: c.id }, data: { status: 'active' } }));
    });

    test('busy blocks: times only, range query, transparent events ignored, replace/upsert/delete, malformed rows skipped', async () => {
      const b = await biz();
      const other = await biz();
      const c = await connect(b.id);
      const co = await connect(other.id);
      const n = await db.replaceBusyBlocks(c.id, [
        { google_event_id: 'in', starts_at: at(2, 9), ends_at: at(2, 10) },
        { google_event_id: 'edge-before', starts_at: at(2, 8), ends_at: at(2, 9) }, // ends exactly at the range start
        { google_event_id: 'free', starts_at: at(2, 9, 30), ends_at: at(2, 10, 30), transparency: 'transparent' },
        { google_event_id: 'allday', starts_at: at(3, 0), ends_at: at(4, 0), all_day: true },
        { google_event_id: 'bad-range', starts_at: at(2, 12), ends_at: at(2, 11) },
        { google_event_id: '', starts_at: at(2, 12), ends_at: at(2, 13) },
        { google_event_id: 'bad-date', starts_at: 'nope', ends_at: at(2, 13) },
        { google_event_id: 'dup', starts_at: at(2, 14), ends_at: at(2, 15) },
        { google_event_id: 'dup', starts_at: at(2, 15), ends_at: at(2, 16) },
      ]);
      expect(n).toBe(5);
      await db.replaceBusyBlocks(co.id, [{ google_event_id: 'in', starts_at: at(2, 9), ends_at: at(2, 10) }]);
      const rows = await db.listBusyBlocksInRange(b.id, at(2, 9), at(4, 0));
      expect(rows.map((r: any) => r.google_event_id)).toEqual(['in', 'dup', 'allday']);
      expect(rows.every((r: any) => r.business_id === b.id && r.summary_redacted === true)).toBe(true);
      expect(rows.find((r: any) => r.google_event_id === 'dup').starts_at).toBe(at(2, 15).toISOString());
      expect(rows.find((r: any) => r.google_event_id === 'allday').all_day).toBe(true);
      expect((await db.listBusyBlocksInRange(b.id, at(2, 9), at(2, 11), { includeTransparent: true })).map((r: any) => r.google_event_id)).toEqual(['in', 'free']);
      expect(await db.listBusyBlocksInRange(b.id, at(2, 9), at(2, 9))).toEqual([]); // empty window
      // the table has no column that could hold a title
      const cols = (await db.prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='calendar_busy_blocks'`)).map((x: any) => x.column_name);
      expect(cols.filter((x: string) => /summary|title|attendee|description|location/.test(x))).toEqual(['summary_redacted']);
      // incremental changes
      expect((await db.upsertBusyBlock(c.id, { google_event_id: 'in', starts_at: at(2, 9), ends_at: at(2, 11) })).ends_at).toBe(at(2, 11).toISOString());
      expect(await db.upsertBusyBlock(c.id, { google_event_id: 'x', starts_at: at(2, 9), ends_at: at(2, 8) })).toBeNull();
      expect(await db.upsertBusyBlock('missing', { google_event_id: 'x', starts_at: at(2, 9), ends_at: at(2, 10) })).toBeNull();
      expect(await db.deleteBusyBlock(c.id, 'in')).toBe(true);
      expect(await db.deleteBusyBlock(c.id, 'in')).toBe(false);
      expect(await db.prisma.calendarBusyBlock.count({ where: { connectionId: co.id } })).toBe(1); // tenant isolation
      expect(await db.replaceBusyBlocks('missing', [])).toBe(0);
      // a full resync replaces everything
      await db.replaceBusyBlocks(c.id, []);
      expect(await db.prisma.calendarBusyBlock.count({ where: { connectionId: c.id } })).toBe(0);
    });

    test('event links: one per booking, lookup both ways, cascade with the booking and the connection', async () => {
      const b = await biz();
      const c = await connect(b.id);
      const k1 = await db.createBooking({ business_id: b.id, customer_name: 'A', customer_phone: '+13055550101', service: 's', scheduled_at: at(5).toISOString() });
      const k2 = await db.createBooking({ business_id: b.id, customer_name: 'B', customer_phone: '+13055550102', service: 's', scheduled_at: at(6).toISOString() });
      const l = await db.upsertEventLink({ booking_id: k1.id, connection_id: c.id, google_event_id: 'g1', etag: '"1"', last_pushed_hash: 'h1' });
      expect(l).toMatchObject({ booking_id: k1.id, google_event_id: 'g1', etag: '"1"', last_pushed_hash: 'h1' });
      const l2 = await db.upsertEventLink({ booking_id: k1.id, connection_id: c.id, google_event_id: 'g1b', etag: '"2"' });
      expect(l2.id).toBe(l.id);
      expect((await db.getEventLinkByBooking(k1.id)).google_event_id).toBe('g1b');
      expect((await db.getEventLinkByGoogleEvent(c.id, 'g1b')).booking_id).toBe(k1.id);
      await expect(db.upsertEventLink({ booking_id: k2.id, connection_id: c.id, google_event_id: 'g1b' })).rejects.toThrow(); // one booking per google event
      expect(await db.touchEventLink(k1.id, { etag: '"3"', last_pushed_hash: 'h3' })).toBe(true);
      expect(await db.getEventLinkByBooking(k1.id)).toMatchObject({ etag: '"3"', last_pushed_hash: 'h3' });
      await db.upsertEventLink({ booking_id: k2.id, connection_id: c.id, google_event_id: 'g2' });
      expect((await db.listEventLinksForConnection(c.id)).length).toBe(2);
      await db.prisma.booking.delete({ where: { id: k1.id } });
      expect(await db.getEventLinkByBooking(k1.id)).toBeNull();
      expect(await db.deleteEventLink(k2.id)).toBe(true);
      expect(await db.deleteEventLink(k2.id)).toBe(false);
      await db.upsertEventLink({ booking_id: k2.id, connection_id: c.id, google_event_id: 'g3' });
      expect(await db.deleteCalendarConnection(c.id)).toBe(true);
      expect(await db.getEventLinkByBooking(k2.id)).toBeNull();
    });

    test('watch renewal listing and channel lookup', async () => {
      const b = await biz();
      const c = await connect(b.id);
      expect((await db.listConnectionsNeedingWatchRenewal(new Date(Date.now() + DAY), 500)).map((x: any) => x.id)).toContain(c.id); // never watched
      await db.updateCalendarSyncState(c.id, { watch_channel_id: `ch-${run}`, watch_resource_id: 'r', watch_expires_at: new Date(Date.now() + 10 * DAY) });
      expect((await db.listConnectionsNeedingWatchRenewal(new Date(Date.now() + DAY), 500)).map((x: any) => x.id)).not.toContain(c.id);
      expect((await db.getCalendarConnectionByChannel(`ch-${run}`)).id).toBe(c.id);
      expect(await db.getCalendarConnectionByChannel('')).toBeNull();
    });
  });

  // ── owner KB changes ───────────────────────────────────────────────────────
  describe('owner knowledge-base changes', () => {
    test('propose does not touch the KB; apply writes it and captures previous in one transaction; revert restores', async () => {
      const b = await biz();
      await db.upsertKnowledgeBase(b.id, { pricing_notes: 'old pricing', services: [{ name: 'AC' }], call_script: 'keep me' });
      const ch = await db.proposeKbChange({ business_id: b.id, source: 'owner_voice', summary: 'Raise diagnostic to $99', patch: { pricing_notes: 'Diagnostic $99', services: [{ name: 'AC', base_price: 99 }] }, created_by: 'owner' });
      expect(ch).toMatchObject({ status: 'proposed', previous: null, applied_at: null });
      expect((await db.getKnowledgeBase(b.id)).pricing_notes).toBe('old pricing');

      const a = await db.applyKbChange(b.id, ch.id);
      expect(a).toMatchObject({ ok: true, changed: true });
      expect(a.change).toMatchObject({ status: 'applied', previous: { pricing_notes: 'old pricing', services: [{ name: 'AC' }] } });
      const kb = await db.getKnowledgeBase(b.id);
      expect(kb).toMatchObject({ pricing_notes: 'Diagnostic $99', call_script: 'keep me' });
      expect(kb.services).toEqual([{ name: 'AC', base_price: 99 }]);
      expect(await db.applyKbChange(b.id, ch.id)).toMatchObject({ ok: true, changed: false }); // idempotent

      const r = await db.revertKbChange(b.id, ch.id);
      expect(r).toMatchObject({ ok: true, changed: true });
      expect(r.change.status).toBe('reverted');
      expect(r.change.reverted_at).not.toBeNull();
      expect(await db.getKnowledgeBase(b.id)).toMatchObject({ pricing_notes: 'old pricing', services: [{ name: 'AC' }], call_script: 'keep me' });
      expect(await db.revertKbChange(b.id, ch.id)).toMatchObject({ ok: true, changed: false });
      expect(await db.applyKbChange(b.id, ch.id)).toMatchObject({ ok: false, reason: 'not_proposed', current: 'reverted' });
    });

    test('revert refuses (and changes nothing) when the field was edited since', async () => {
      const b = await biz();
      await db.upsertKnowledgeBase(b.id, { pricing_notes: 'v0', system_prompt: 'sp0' });
      const ch = await db.proposeKbChange({ business_id: b.id, source: 'dashboard', summary: 's', patch: { pricing_notes: 'v1', system_prompt: 'sp1' } });
      await db.applyKbChange(b.id, ch.id);
      await db.upsertKnowledgeBase(b.id, { pricing_notes: 'edited by a human' });
      const r = await db.revertKbChange(b.id, ch.id);
      expect(r).toMatchObject({ ok: false, reason: 'changed_since', conflicts: ['pricing_notes'] });
      expect(await db.getKnowledgeBase(b.id)).toMatchObject({ pricing_notes: 'edited by a human', system_prompt: 'sp1' }); // nothing was restored
      expect((await db.getKbChange(b.id, ch.id)).status).toBe('applied');
      // fields the change did NOT touch never block or get restored
      await db.upsertKnowledgeBase(b.id, { pricing_notes: 'v1' });
      await db.upsertKnowledgeBase(b.id, { call_script: 'untouched field edited' });
      expect(await db.revertKbChange(b.id, ch.id)).toMatchObject({ ok: true, changed: true });
      expect(await db.getKnowledgeBase(b.id)).toMatchObject({ pricing_notes: 'v0', system_prompt: 'sp0', call_script: 'untouched field edited' });
    });

    test('services compared irrespective of JSON key order; applying creates a missing KB row', async () => {
      const b = await biz();
      const ch = await db.proposeKbChange({ business_id: b.id, source: 'owner_sms', summary: 's', patch: { services: [{ name: 'X', base_price: 5, duration_minutes: 30 }] } });
      expect((await db.applyKbChange(b.id, ch.id)).ok).toBe(true);
      expect((await db.revertKbChange(b.id, ch.id)).ok).toBe(true);
      expect((await db.getKnowledgeBase(b.id)).services).toEqual([]);
    });

    test('concurrent applies of one change: exactly one writes; other tenants cannot touch it; invalid input is refused', async () => {
      const b = await biz();
      const other = await biz();
      const ch = await db.proposeKbChange({ business_id: b.id, source: 'owner_voice', summary: 's', patch: { pricing_notes: 'once' } });
      const rs = await Promise.all(Array.from({ length: 8 }, () => db.applyKbChange(b.id, ch.id)));
      expect(rs.every((r: any) => r.ok)).toBe(true);
      expect(rs.filter((r: any) => r.changed).length).toBe(1);
      expect((await db.getKbChange(b.id, ch.id)).previous).toEqual({ pricing_notes: '' });
      expect(await db.applyKbChange(other.id, ch.id)).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await db.revertKbChange(other.id, ch.id)).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await db.getKbChange(other.id, ch.id)).toBeNull();
      await expect(db.proposeKbChange({ business_id: b.id, source: 'owner_voice', summary: 's', patch: {} })).rejects.toThrow();
      await expect(db.proposeKbChange({ business_id: b.id, source: 'owner_voice', summary: ' ', patch: { pricing_notes: 'x' } })).rejects.toThrow();
      await expect(db.proposeKbChange({ business_id: b.id, source: 'fax', summary: 's', patch: { pricing_notes: 'x' } })).rejects.toThrow();
      await expect(db.proposeKbChange({ business_id: b.id, source: 'owner_voice', summary: 's', patch: { evil: 1 } })).rejects.toThrow();
    });

    test('reject, revert-before-apply, call link survives call deletion, and keyset paging', async () => {
      const b = await biz();
      const call = await db.createCall({ business_id: b.id, kind: 'owner', caller_phone: '+13055550177' });
      expect(call.kind).toBe('owner');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await db.proposeKbChange({ business_id: b.id, source: 'owner_voice', summary: `change ${i}`, patch: { pricing_notes: `n${i}` }, call_id: call.id })).id);
      expect(await db.rejectKbChange(b.id, ids[0])).toMatchObject({ ok: true, changed: true });
      expect(await db.rejectKbChange(b.id, ids[0])).toMatchObject({ ok: true, changed: false });
      expect(await db.applyKbChange(b.id, ids[0])).toMatchObject({ ok: false, reason: 'not_proposed' });
      expect(await db.revertKbChange(b.id, ids[1])).toMatchObject({ ok: false, reason: 'not_applied' });
      await db.applyKbChange(b.id, ids[1]);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard++) {
        const page: any = await db.listKbChanges(b.id, { limit: 2, cursor });
        seen.push(...page.items.map((x: any) => x.id));
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      expect(seen.length).toBe(5);
      expect(new Set(seen).size).toBe(5);
      expect((await db.listKbChanges(b.id, { status: 'applied' })).items.map((x: any) => x.id)).toEqual([ids[1]]);
      await db.prisma.call.delete({ where: { id: call.id } });
      expect((await db.getKbChange(b.id, ids[2])).call_id).toBeNull();
    });

    test('database CHECKs: shape of status / patch', async () => {
      const b = await biz();
      const bad = (data: Record<string, unknown>) => db.prisma.ownerKbChange.create({ data: { businessId: b.id, source: 'dashboard', summary: 's', ...data } });
      await fails(bad({ status: 'applied' })); // applied needs applied_at
      await fails(bad({ status: 'weird' }));
      await fails(bad({ source: 'carrier_pigeon' }));
      await fails(bad({ patch: [1] }));
    });
  });

  // ── live transcript ────────────────────────────────────────────────────────
  describe('live transcript', () => {
    const ev = (seq: number, role: 'agent' | 'caller' | 'system' = 'caller', text = `t${seq}`, is_final = true) => ({ seq, role, text, at: new Date(1_800_000_000_000 + seq * 1000), is_final });

    test('append is idempotent per seq, interim rows are replaced, final rows are immutable, listing pages by seq', async () => {
      const b = await biz();
      const call = await db.createCall({ business_id: b.id, caller_phone: '+13055550166' });
      expect(await db.appendTranscriptEvents(call.id, [ev(0, 'agent'), ev(1), ev(2, 'caller', 'par', false)])).toEqual({ ok: true, stored: 3, skipped: 0 });
      expect(await db.appendTranscriptEvents(call.id, [ev(0, 'agent'), ev(1)])).toEqual({ ok: true, stored: 0, skipped: 2 }); // retried batch: no duplicates
      expect(await db.appendTranscriptEvents(call.id, [ev(2, 'caller', 'partial more', false), ev(3)])).toEqual({ ok: true, stored: 2, skipped: 0 });
      expect(await db.appendTranscriptEvents(call.id, [ev(2, 'caller', 'the final words', true)])).toMatchObject({ ok: true, stored: 1 });
      expect(await db.appendTranscriptEvents(call.id, [ev(2, 'caller', 'late interim', false)])).toMatchObject({ ok: true, stored: 0, skipped: 1 });
      expect(await db.appendTranscriptEvents(call.id, [ev(5, 'system', 'a'), ev(5, 'system', 'b')])).toMatchObject({ ok: true, stored: 1 }); // same seq twice in one batch: last wins
      const all = await db.listTranscriptEventsAfter(call.id, -1);
      expect(all.map((e: any) => e.seq)).toEqual([0, 1, 2, 3, 5]);
      expect(all[2]).toMatchObject({ text: 'the final words', is_final: true, role: 'caller', call_id: call.id });
      expect(all[4].text).toBe('b');
      expect((await db.listTranscriptEventsAfter(call.id, 1, 2)).map((e: any) => e.seq)).toEqual([2, 3]);
      expect(await db.listTranscriptEventsAfter(call.id, 5)).toEqual([]);
      expect(await db.lastTranscriptSeq(call.id)).toBe(5);
      expect(await db.lastTranscriptSeq('none')).toBe(-1);
      // tenant scoping
      const other = await biz();
      expect(await db.listTranscriptEventsAfter(call.id, -1, 10, { businessId: other.id })).toEqual([]);
      expect((await db.listTranscriptEventsAfter(call.id, -1, 10, { businessId: b.id })).length).toBe(5);
      // concurrency: parallel identical batches never duplicate
      await Promise.all(Array.from({ length: 6 }, () => db.appendTranscriptEvents(call.id, [ev(10), ev(11)])));
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: call.id, seq: { in: [10, 11] } } })).toBe(2);
    });

    test('validation: unknown call, malformed events, oversized batches', async () => {
      const b = await biz();
      const call = await db.createCall({ business_id: b.id });
      expect(await db.appendTranscriptEvents('missing', [ev(0)])).toEqual({ ok: false, reason: 'call_not_found' });
      expect(await db.appendTranscriptEvents(call.id, [{ ...ev(0), role: 'robot' as never }])).toEqual({ ok: false, reason: 'invalid_events' });
      expect(await db.appendTranscriptEvents(call.id, [ev(-1)])).toEqual({ ok: false, reason: 'invalid_events' });
      expect(await db.appendTranscriptEvents(call.id, [{ ...ev(0), at: 'nope' }])).toEqual({ ok: false, reason: 'invalid_events' });
      expect(await db.appendTranscriptEvents(call.id, Array.from({ length: 501 }, (_, i) => ev(i)))).toEqual({ ok: false, reason: 'too_many_events' });
      expect(await db.appendTranscriptEvents(call.id, [])).toEqual({ ok: true, stored: 0, skipped: 0 });
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0);
      expect(await db.appendTranscriptEvents(call.id, [ev(0, 'caller', 'x'.repeat(30_000))])).toMatchObject({ ok: true, stored: 1 });
      expect((await db.listTranscriptEventsAfter(call.id, -1))[0].text.length).toBe(20_000);
    });

    test('a declined call never gets events: helper refuses, the database skips raw inserts, and a late decline deletes what exists', async () => {
      const b = await biz();
      const declined = await db.createCall({ business_id: b.id, consent_status: 'declined' });
      expect(await db.appendTranscriptEvents(declined.id, [ev(0)])).toEqual({ ok: false, reason: 'consent_declined' });
      // bypassing the helper: the trigger silently skips the row
      await db.prisma.callTranscriptEvent.createMany({ data: [{ callId: declined.id, seq: 0, role: 'caller', text: 'sneaky', at: new Date() }] });
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: declined.id } })).toBe(0);
      // consent withdrawn mid-call: what was stored is deleted, and nothing more is accepted
      const live = await db.createCall({ business_id: b.id, consent_status: 'disclosed' });
      await db.appendTranscriptEvents(live.id, [ev(0), ev(1)]);
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: live.id } })).toBe(2);
      await db.updateCall(live.id, { consent_status: 'declined' });
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: live.id } })).toBe(0);
      expect(await db.appendTranscriptEvents(live.id, [ev(2)])).toEqual({ ok: false, reason: 'consent_declined' });
      await db.updateCall(live.id, { consent_status: 'disclosed' }); // sticky
      expect((await db.getCall(live.id)).consent_status).toBe('declined');
      // declined is also the state for an 'unknown' call turned declined by a raw update
      const raw = await db.createCall({ business_id: b.id });
      await db.appendTranscriptEvents(raw.id, [ev(0)]);
      await db.prisma.call.update({ where: { id: raw.id }, data: { consentStatus: 'declined' } });
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: raw.id } })).toBe(0);
    });

    test('retention purge, erasure and export cover the events', async () => {
      const b = await biz({ retention_days: 30 });
      const old = new Date(Date.now() - 40 * DAY);
      const oldCall = await db.createCall({ business_id: b.id, caller_phone: '+13055550155', started_at: old.toISOString() });
      const freshCall = await db.createCall({ business_id: b.id, caller_phone: '+13055550156' });
      await db.appendTranscriptEvents(oldCall.id, [ev(0), ev(1), ev(2)]);
      await db.appendTranscriptEvents(freshCall.id, [ev(0)]);
      expect((await db.previewExpiredData()).transcript_events).toBeGreaterThanOrEqual(3);
      const counts = await db.purgeExpiredData(new Date());
      expect(counts.transcript_events).toBeGreaterThanOrEqual(3);
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: oldCall.id } })).toBe(0);
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: freshCall.id } })).toBe(1);
      const { exportCustomerData } = await import('../../src/lib/privacy');
      const exp = await exportCustomerData(b.id, '+13055550156');
      expect(exp.transcript_events).toMatchObject([{ call_id: freshCall.id, seq: 0, text: 't0' }]);
      expect(exp.calls.length).toBe(1);
      const erased = await db.eraseCustomerData(b.id, '+13055550156');
      expect(erased).toMatchObject({ calls: 1, transcript_events: 1 });
      expect(await db.prisma.callTranscriptEvent.count({ where: { callId: freshCall.id } })).toBe(0);
    });
  });

  // ── caller trust, transfer, metering ───────────────────────────────────────
  describe('call trust, transfer status and metering claims', () => {
    test('defaults, owner calls, STIR status and derived caller_verified', async () => {
      const b = await biz();
      const c = await db.createCall({ business_id: b.id });
      expect(c).toMatchObject({ kind: 'customer', transfer_status: 'none', stir_status: null, caller_verified: null, metered_at: null, reconcile_attempts: 0 });
      expect(await db.setCallTrust(c.id, 'TN-Validation-Passed-A')).toBe(true);
      expect(await db.getCall(c.id)).toMatchObject({ stir_status: 'TN-Validation-Passed-A', caller_verified: true });
      await db.setCallTrust(c.id, 'TN-Validation-Passed-B');
      expect(await db.getCall(c.id)).toMatchObject({ stir_status: 'TN-Validation-Passed-B', caller_verified: false });
      await db.setCallTrust(c.id, 'bad value with spaces');
      expect(await db.getCall(c.id)).toMatchObject({ stir_status: null, caller_verified: null });
      expect(await db.setCallTrust('missing', 'No-TN-Validation')).toBe(false);
      expect(db.attestationLevel('TN-Validation-Failed-C')).toBe('failed');
      expect((await db.createCall({ business_id: b.id, kind: 'owner', stir_status: 'No-TN-Validation', caller_verified: false })).kind).toBe('owner');
      await fails(db.prisma.call.update({ where: { id: c.id }, data: { kind: 'robot' } }));
    });

    test('transfer status: valid values only, connected is final', async () => {
      const b = await biz();
      const c = await db.createCall({ business_id: b.id });
      expect(await db.setTransferStatus(c.id, 'attempted')).toBe(true);
      expect(await db.setTransferStatus(c.id, 'connected')).toBe(true);
      expect(await db.setTransferStatus(c.id, 'failed')).toBe(false);
      expect((await db.getCall(c.id)).transfer_status).toBe('connected');
      await expect(db.setTransferStatus(c.id, 'teleported')).rejects.toThrow();
      expect((await db.updateCall(c.id, { transfer_status: 'bogus' as never })).transfer_status).toBe('connected'); // invalid values are ignored
      await fails(db.prisma.call.update({ where: { id: c.id }, data: { transferStatus: 'bogus' } }));
    });

    test('claimCallMetering has exactly one winner; reconcile listing and attempts', async () => {
      const b = await biz();
      const c = await db.createCall({ business_id: b.id, conversation_id: `conv-${run}-1`, started_at: new Date(Date.now() - 3600_000).toISOString() });
      const wins = await Promise.all(Array.from({ length: 10 }, () => db.claimCallMetering(c.id)));
      expect(wins.filter(Boolean).length).toBe(1);
      expect((await db.getCall(c.id)).metered_at).not.toBeNull();
      const u = await db.createCall({ business_id: b.id, conversation_id: `conv-${run}-2`, started_at: new Date(Date.now() - 3600_000).toISOString() });
      const owner = await db.createCall({ business_id: b.id, kind: 'owner', conversation_id: `conv-${run}-3`, started_at: new Date(Date.now() - 3600_000).toISOString() });
      const noConv = await db.createCall({ business_id: b.id, started_at: new Date(Date.now() - 3600_000).toISOString() });
      const fresh = await db.createCall({ business_id: b.id, conversation_id: `conv-${run}-4` });
      const ids = () => db.listCallsNeedingReconcile({ olderThan: new Date(Date.now() - 600_000), limit: 500 }).then((r: any[]) => r.map((x) => x.id));
      let list = await ids();
      expect(list).toContain(u.id);
      expect(list).toContain(owner.id); // owner-line calls use AI minutes too: reconciled like any other call
      for (const skip of [c.id, noConv.id, fresh.id]) expect(list).not.toContain(skip); // metered / no key / too recent
      expect(await db.bumpReconcileAttempt(u.id)).toBe(1);
      expect(await db.bumpReconcileAttempt(u.id)).toBe(2);
      list = await db.listCallsNeedingReconcile({ olderThan: new Date(Date.now() - 600_000), maxAttempts: 2, limit: 500 }).then((r: any[]) => r.map((x) => x.id));
      expect(list).not.toContain(u.id);
      expect(await db.bumpReconcileAttempt('missing')).toBeNull();
      await db.releaseCallMetering(c.id);
      expect(await db.claimCallMetering(c.id)).toBe(true);
    });
  });

  // ── usage warnings ─────────────────────────────────────────────────────────
  describe('usage warnings', () => {
    test('markWarned: exactly one winner per kind+level+period; independent kinds; re-arms next month; unmark', async () => {
      const b = await biz();
      const now = new Date('2027-03-15T12:00:00Z');
      expect(await db.markWarned(b.id, 'sms', 80, now)).toBe(false); // no usage row yet: nothing to warn about
      await db.recordSms(b.id, 1, now);
      const wins = await Promise.all(Array.from({ length: 20 }, () => db.markWarned(b.id, 'sms', 80, now)));
      expect(wins.filter(Boolean).length).toBe(1);
      expect(await db.markWarned(b.id, 'sms', 80, now)).toBe(false);
      expect(await db.markWarned(b.id, 'sms', 100, now)).toBe(true); // other level
      expect(await db.markWarned(b.id, 'ai', 80, now)).toBe(true); // other kind
      expect(await db.markWarned(b.id, 'forward', 100, now)).toBe(true);
      const w = await db.getUsageWarnings(b.id, now);
      expect(w.sms_80).not.toBeNull();
      expect(w.sms_100).not.toBeNull();
      expect(w.ai_80).not.toBeNull();
      expect(w.ai_100).toBeNull();
      expect(w.forward_80).toBeNull();
      expect(w.forward_100).not.toBeNull();
      // next month = new counter row = armed again
      const next = new Date('2027-04-02T12:00:00Z');
      await db.recordSms(b.id, 1, next);
      expect(await db.markWarned(b.id, 'sms', 80, next)).toBe(true);
      expect((await db.getUsageWarnings(b.id, now)).sms_80).not.toBeNull(); // March untouched
      // a failed send gives its claim back
      await db.unmarkWarned(b.id, 'sms', 80, next);
      expect(await db.markWarned(b.id, 'sms', 80, next)).toBe(true);
      await expect(db.markWarned(b.id, 'sms', 50 as never, now)).rejects.toThrow();
      await expect(db.markWarned(b.id, 'voicemail' as never, 80, now)).rejects.toThrow();
      expect(await db.markWarned('missing', 'sms', 80, now)).toBe(false);
      expect(await db.getUsageWarnings('missing')).toBeNull();
    });

    test('the period follows the business time zone', async () => {
      const b = await biz({ timezone: 'Pacific/Auckland' }); // +13h in March: 2027-03-31 12:00Z is already April there
      const t = new Date('2027-03-31T12:00:00Z');
      await db.recordSms(b.id, 1, t);
      expect(await db.markWarned(b.id, 'sms', 80, new Date('2027-03-30T00:00:00Z'))).toBe(false); // March counter does not exist
      expect(await db.markWarned(b.id, 'sms', 80, t)).toBe(true);
    });
  });

  // ── passkeys ───────────────────────────────────────────────────────────────
  describe('passkeys', () => {
    const key = () => new Uint8Array([1, 2, 3, 4, 250, 251, 252]);

    test('credentials: add, list (no key), verification record, counter rule, rename, delete scoped to the owner', async () => {
      const b = await biz();
      const u = await user('pk1', 'owner', b.id);
      const v = await user('pk2', 'owner', b.id);
      const cid = `cred_${run}-1_x`;
      const p = await db.addPasskey({ user_id: u.id, credential_id: cid, public_key: key(), counter: 5, transports: ['internal', 'hybrid'], device_type: 'multiDevice', backed_up: true, name: ' My laptop ' });
      expect(p).toMatchObject({ credential_id: cid, name: 'My laptop', device_type: 'multiDevice', backed_up: true, transports: ['internal', 'hybrid'], last_used_at: null });
      expect('public_key' in p).toBe(false);
      expect((await db.listPasskeys(u.id)).length).toBe(1);
      expect('public_key' in (await db.listPasskeys(u.id))[0]).toBe(false);
      const full = await db.getPasskeyByCredentialId(cid);
      expect(Array.from(full.public_key)).toEqual(Array.from(key()));
      expect(full.counter).toBe(5);
      await expect(db.addPasskey({ user_id: v.id, credential_id: cid, public_key: key() })).rejects.toBeInstanceOf(db.PasskeyExistsError);
      await expect(db.addPasskey({ user_id: u.id, credential_id: 'bad id!', public_key: key() })).rejects.toThrow();
      await expect(db.addPasskey({ user_id: u.id, credential_id: 'okid', public_key: new Uint8Array() })).rejects.toThrow();
      // counter must increase
      expect(await db.recordPasskeyUse(cid, 5)).toBe(false);
      expect(await db.recordPasskeyUse(cid, 4)).toBe(false);
      expect(await db.recordPasskeyUse(cid, 6)).toBe(true);
      expect((await db.getPasskeyByCredentialId(cid)).counter).toBe(6);
      expect((await db.listPasskeys(u.id))[0].last_used_at).not.toBeNull();
      expect(await db.recordPasskeyUse(cid, -1)).toBe(false);
      // authenticators that always report 0
      const zero = `cred_${run}-zero_x`;
      await db.addPasskey({ user_id: u.id, credential_id: zero, public_key: key() });
      expect(await db.recordPasskeyUse(zero, 0)).toBe(true);
      expect(await db.recordPasskeyUse(zero, 0)).toBe(true);
      expect(await db.recordPasskeyUse(zero, 1)).toBe(true);
      expect(await db.recordPasskeyUse(zero, 0)).toBe(false);
      // concurrent assertions with the same counter: one wins
      const race = await Promise.all(Array.from({ length: 8 }, () => db.recordPasskeyUse(cid, 100)));
      expect(race.filter(Boolean).length).toBe(1);
      const mine = (await db.listPasskeys(u.id))[0];
      expect(await db.renamePasskey(v.id, mine.id, 'hijack')).toBe(false);
      expect(await db.renamePasskey(u.id, mine.id, 'Renamed')).toBe(true);
      expect(await db.renamePasskey(u.id, mine.id, '   ')).toBe(false);
      expect(await db.deletePasskey(v.id, mine.id)).toBe(false);
      expect(await db.deletePasskey(u.id, mine.id)).toBe(true);
      expect(await db.countPasskeys(u.id)).toBe(1);
      expect(await db.getPasskeyByCredentialId('')).toBeNull();
    });

    test('at most 20 passkeys per user, even when registered concurrently; deleting the user deletes them', async () => {
      const b = await biz();
      const u = await user('pk3', 'owner', b.id);
      const rs = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => db.addPasskey({ user_id: u.id, credential_id: `cred_${run}_many_${i}`, public_key: key() })));
      expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(20);
      expect(rs.filter((r: any) => r.status === 'rejected').every((r: any) => r.reason instanceof db.PasskeyLimitError)).toBe(true);
      await db.prisma.user.delete({ where: { id: u.id } });
      expect(await db.prisma.passkeyCredential.count({ where: { userId: u.id } })).toBe(0);
    });

    test('challenges are single-use, purpose- and user-bound, and expire', async () => {
      const b = await biz();
      const u = await user('pk4', 'owner', b.id);
      const w = await user('pk5', 'staff', b.id);
      const chal = (s: string) => `${s}-${run}-challenge-value-0123456789`;
      await db.createWebauthnChallenge({ purpose: 'register', challenge: chal('r1'), user_id: u.id });
      expect(await db.consumeWebauthnChallenge('login', chal('r1'), { userId: u.id })).toBe(false); // wrong purpose
      expect(await db.consumeWebauthnChallenge('register', chal('r1'), { userId: w.id })).toBe(false); // someone else's
      expect(await db.consumeWebauthnChallenge('register', chal('r1'))).toBe(false); // no user given
      const wins = await Promise.all(Array.from({ length: 10 }, () => db.consumeWebauthnChallenge('register', chal('r1'), { userId: u.id })));
      expect(wins.filter(Boolean).length).toBe(1);
      expect(await db.consumeWebauthnChallenge('register', chal('r1'), { userId: u.id })).toBe(false);
      // discoverable login: no user on the challenge
      await db.createWebauthnChallenge({ purpose: 'login', challenge: chal('l1') });
      expect(await db.consumeWebauthnChallenge('login', chal('l1'))).toBe(true);
      // expiry
      const past = new Date(Date.now() - 10 * 60_000);
      await db.createWebauthnChallenge({ purpose: 'reauth', challenge: chal('x1'), user_id: u.id, now: past, ttlMs: 60_000 });
      expect(await db.consumeWebauthnChallenge('reauth', chal('x1'), { userId: u.id })).toBe(false);
      expect(await db.consumeWebauthnChallenge('reauth', chal('x1'), { userId: u.id, now: new Date(past.getTime() + 1000) })).toBe(true);
      await db.createWebauthnChallenge({ purpose: 'reauth', challenge: chal('x2'), user_id: u.id, now: new Date(Date.now() - 3 * DAY), ttlMs: 1000 });
      expect(await db.deleteExpiredWebauthnChallenges()).toBeGreaterThanOrEqual(1);
      // input rules
      await expect(db.createWebauthnChallenge({ purpose: 'register', challenge: chal('r2') })).rejects.toThrow(); // register needs a user
      await expect(db.createWebauthnChallenge({ purpose: 'login', challenge: 'short' })).rejects.toThrow();
      await expect(db.createWebauthnChallenge({ purpose: 'bogus' as never, challenge: chal('r3') })).rejects.toThrow();
      await expect(db.createWebauthnChallenge({ purpose: 'login', challenge: chal('l1') })).rejects.toThrow(); // challenge hash is unique
      // raw rows obey the CHECK
      await fails(db.prisma.webauthnChallenge.create({ data: { purpose: 'register', challengeHash: `h-${run}`, expiresAt: new Date() } }));
    });
  });

  // ── memberships ────────────────────────────────────────────────────────────
  describe('memberships', () => {
    test('legacy writes are mirrored: new users get a membership, role changes follow, admins have none', async () => {
      const b = await biz();
      const o = await user('m1', 'owner', b.id);
      const s = await user('m2', 'staff', b.id);
      const a = await user('m3', 'admin');
      expect(await db.getMembership(o.id, b.id)).toMatchObject({ role: 'owner', disabled_at: null });
      expect(await db.getMembership(s.id, b.id)).toMatchObject({ role: 'staff' });
      expect(await db.getMembership(a.id, b.id)).toBeNull();
      expect(await db.listMembershipsForUser(a.id)).toEqual([]);
      await db.prisma.user.update({ where: { id: s.id }, data: { role: 'owner' } }); // old code path
      expect((await db.getMembership(s.id, b.id)).role).toBe('owner');
      expect(await db.countActiveOwners(b.id)).toBe(2);
      await expect(db.addMembership({ user_id: a.id, business_id: b.id, role: 'owner' })).rejects.toMatchObject({ code: 'admin_account' });
      await expect(db.addMembership({ user_id: 'missing', business_id: b.id, role: 'owner' })).rejects.toMatchObject({ code: 'user_not_found' });
      await expect(db.addMembership({ user_id: o.id, business_id: 'missing', role: 'owner' })).rejects.toMatchObject({ code: 'business_not_found' });
      await expect(db.addMembership({ user_id: o.id, business_id: b.id, role: 'admin' as never })).rejects.toMatchObject({ code: 'invalid_role' });
      await fails(db.prisma.membership.create({ data: { userId: o.id, businessId: (await biz()).id, role: 'admin' } })); // CHECK
    });

    test('one account in two businesses: roles are per business, lists and the account switcher read memberships', async () => {
      const a = await biz({ name: 'Alpha' });
      const c = await biz({ name: 'Charlie' });
      const u = await user('m4', 'owner', a.id);
      const t = await user('m5', 'owner', c.id);
      const added = await db.addMembership({ user_id: u.id, business_id: c.id, role: 'staff' });
      expect(added.created).toBe(true);
      expect((await db.addMembership({ user_id: u.id, business_id: c.id, role: 'staff' })).created).toBe(false);
      const list = await db.listMembershipsForUser(u.id);
      expect(list.map((m: any) => [m.business_name, m.role])).toEqual([['Alpha', 'owner'], ['Charlie', 'staff']]);
      // legacy primary untouched by the second membership
      expect(await db.getUserById(u.id)).toMatchObject({ business_id: a.id, role: 'owner' });
      const teamC = await db.listBusinessMembers(c.id);
      expect(teamC.map((m: any) => [m.user_id, m.role]).sort()).toEqual([[t.id, 'owner'], [u.id, 'staff']].sort());
      // listBusinessUsers (legacy shape) reads memberships: the role is the one IN that business
      const usersC = await db.listBusinessUsers(c.id);
      expect(usersC.find((x: any) => x.id === u.id)).toMatchObject({ role: 'staff', business_id: c.id });
      expect((await db.listBusinessUsers(a.id)).find((x: any) => x.id === u.id)).toMatchObject({ role: 'owner', business_id: a.id });
      // per-business role change; primary-business change also updates the legacy column
      expect(await db.setMembershipRole(u.id, c.id, 'owner')).toMatchObject({ ok: true, changed: true });
      expect((await db.getUserById(u.id)).role).toBe('owner'); // unchanged: c is not the primary
      expect(await db.setMembershipRole(u.id, c.id, 'staff')).toMatchObject({ ok: true, changed: true }); // t still owns c
      expect(await db.setMembershipRole(u.id, c.id, 'staff')).toMatchObject({ ok: true, changed: false });
      expect(await db.setMembershipRole('nobody', c.id, 'staff')).toEqual({ ok: false, reason: 'not_found' });
      // disabling one membership leaves the account and the other business alone
      expect(await db.disableMembership(u.id, c.id)).toMatchObject({ ok: true, changed: true });
      expect((await db.listMembershipsForUser(u.id)).map((m: any) => m.business_id)).toEqual([a.id]);
      expect((await db.listMembershipsForUser(u.id, { includeDisabled: true })).length).toBe(2);
      expect((await db.listBusinessMembers(c.id)).map((m: any) => m.user_id)).toEqual([t.id]);
      expect((await db.listBusinessMembers(c.id, { includeDisabled: true })).length).toBe(2);
      expect((await db.getUserById(u.id)).disabled_at).toBeNull();
      expect((await db.listBusinessUsers(c.id)).find((x: any) => x.id === u.id).disabled_at).not.toBeNull();
      expect(await db.enableMembership(u.id, c.id)).toMatchObject({ ok: true, changed: true });
      // re-adding a disabled membership re-enables it
      await db.disableMembership(u.id, c.id);
      expect((await db.addMembership({ user_id: u.id, business_id: c.id, role: 'staff' })).membership.disabled_at).toBeNull();
    });

    test('last-owner protection counts memberships, also under concurrency', async () => {
      const a = await biz();
      const c = await biz();
      const o1 = await user('m6', 'owner', a.id);
      const o2 = await user('m7', 'owner', c.id);
      await db.addMembership({ user_id: o2.id, business_id: a.id, role: 'owner' }); // o2 owns A through a second membership
      expect(await db.countActiveOwners(a.id)).toBe(2);
      const results = await Promise.all([db.disableMembership(o1.id, a.id), db.setMembershipRole(o2.id, a.id, 'staff')]);
      expect(results.filter((r: any) => r.ok).length).toBe(1);
      expect(results.filter((r: any) => !r.ok && r.reason === 'last_owner').length).toBe(1);
      expect(await db.countActiveOwners(a.id)).toBe(1);
      // an account-level disable also removes an owner from the count
      const [owner] = (await db.listBusinessMembers(a.id)).filter((m: any) => m.role === 'owner');
      await db.setUserDisabled(owner.user_id, true);
      expect(await db.countActiveOwners(a.id)).toBe(0);
      await db.setUserDisabled(owner.user_id, false);
      expect(await db.countActiveOwners(a.id)).toBe(1);
      // the only owner cannot be disabled or demoted
      expect(await db.disableMembership(owner.user_id, a.id)).toEqual({ ok: false, reason: 'last_owner' });
      expect(await db.setMembershipRole(owner.user_id, a.id, 'staff')).toEqual({ ok: false, reason: 'last_owner' });
      expect(await db.countActiveOwners('missing')).toBe(0);
    });

    test('setSessionActiveBusiness validates membership in the same statement', async () => {
      const a = await biz();
      const c = await biz();
      const d = await biz();
      const u = await user('m8', 'owner', a.id);
      await db.addMembership({ user_id: u.id, business_id: c.id, role: 'staff' });
      const { session } = await db.createSession(u.id);
      expect(session.active_business_id).toBeNull();
      expect(await db.setSessionActiveBusiness(session.id, c.id)).toBe(true);
      expect((await db.prisma.userSession.findUnique({ where: { id: session.id } })).activeBusinessId).toBe(c.id);
      expect(await db.setSessionActiveBusiness(session.id, d.id)).toBe(false); // not a member
      expect((await db.prisma.userSession.findUnique({ where: { id: session.id } })).activeBusinessId).toBe(c.id);
      expect((await db.resolveActiveMembership(u.id, c.id)).business_id).toBe(c.id);
      expect((await db.resolveActiveMembership(u.id, d.id)).business_id).toBe(a.id); // falls back to the primary
      expect((await db.resolveActiveMembership(u.id, null)).business_id).toBe(a.id);
      // losing the membership resets the session
      await db.disableMembership(u.id, c.id);
      expect((await db.prisma.userSession.findUnique({ where: { id: session.id } })).activeBusinessId).toBeNull();
      expect(await db.setSessionActiveBusiness(session.id, c.id)).toBe(false); // disabled membership
      expect(await db.setSessionActiveBusiness(session.id, null)).toBe(true);
      expect(await db.setSessionActiveBusiness('missing', a.id)).toBe(false);
      // break-glass sessions have no account and cannot be pointed anywhere
      const admin = await db.createAdminSession();
      expect(await db.setSessionActiveBusiness(admin.session.id, a.id)).toBe(false);
      // a disabled account cannot switch
      await db.setSessionActiveBusiness(session.id, a.id);
      await db.prisma.user.update({ where: { id: u.id }, data: { disabledAt: new Date() } });
      expect(await db.setSessionActiveBusiness(session.id, a.id)).toBe(false);
      expect(await db.resolveActiveMembership('nobody', null)).toBeNull();
    });

    test('deleting a business keeps people who belong elsewhere (and moves their primary), deletes the rest', async () => {
      const a = await biz();
      const c = await biz();
      const shared = await user('m9', 'owner', a.id);
      const solo = await user('m10', 'staff', a.id);
      await db.addMembership({ user_id: shared.id, business_id: c.id, role: 'staff' });
      await db.prisma.business.delete({ where: { id: a.id } });
      expect(await db.getUserById(solo.id)).toBeNull(); // single-business account: removed with the business, as before
      expect(await db.getUserById(shared.id)).toMatchObject({ business_id: c.id, role: 'staff' });
      expect((await db.listMembershipsForUser(shared.id)).map((m: any) => m.business_id)).toEqual([c.id]);
      expect(await db.prisma.membership.count({ where: { businessId: a.id } })).toBe(0);
      // a session that was working in the deleted business falls back to the primary
    });

    test('inviting an account that already exists: accepting adds a membership, the token is single-use and address-bound', async () => {
      const a = await biz();
      const c = await biz();
      const existing = await user('m11', 'owner', a.id);
      const stranger = await user('m12', 'owner', a.id);
      const { token } = await db.createEmailToken({ purpose: 'invite', email: existing.email, business_id: c.id, role: 'staff', invited_by: stranger.id, user_id: existing.id });
      // wrong account: nothing is consumed
      expect(await db.acceptInviteForExistingUser(token, stranger.id)).toBeNull();
      expect(await db.peekEmailToken('invite', token)).not.toBeNull();
      expect(await db.acceptInviteForExistingUser('x'.repeat(30), existing.id)).toBeNull();
      const ok = await db.acceptInviteForExistingUser(token, existing.id);
      expect(ok).toMatchObject({ created: true, membership: { user_id: existing.id, business_id: c.id, role: 'staff' }, invite: { business_id: c.id } });
      expect(await db.acceptInviteForExistingUser(token, existing.id)).toBeNull(); // used
      expect((await db.listMembershipsForUser(existing.id)).length).toBe(2);
      // a verify token is not an invite
      const v = await db.createEmailToken({ purpose: 'verify', email: existing.email, user_id: existing.id });
      expect(await db.acceptInviteForExistingUser(v.token, existing.id)).toBeNull();
      // concurrent acceptance: one wins
      const d = await biz();
      const t2 = await db.createEmailToken({ purpose: 'invite', email: stranger.email, business_id: d.id, role: 'owner', user_id: stranger.id });
      const rs = await Promise.all(Array.from({ length: 5 }, () => db.acceptInviteForExistingUser(t2.token, stranger.id)));
      expect(rs.filter(Boolean).length).toBe(1);
    });
  });

  // ── locale / vertical / voice / refund policy ──────────────────────────────
  describe('business and user settings', () => {
    test('defaults, validated updates and CHECK constraints', async () => {
      const b = await biz();
      expect(b).toMatchObject({ locale_default: 'en', vertical: 'hvac', voice_id: null, voice_name: null, refund_policy: 'full_24h', refund_policy_text: null, billing_interval: 'month' });
      const u = await db.updateBusiness(b.id, { locale_default: 'es', vertical: 'dental', voice_id: 'v123', voice_name: 'Sofia', refund_policy: 'full_48h', refund_policy_text: 'Cancel 48h before.', billing_interval: 'year' });
      expect(u).toMatchObject({ locale_default: 'es', vertical: 'dental', voice_id: 'v123', voice_name: 'Sofia', refund_policy: 'full_48h', refund_policy_text: 'Cancel 48h before.', billing_interval: 'year' });
      // unknown values are ignored, never stored
      const same = await db.updateBusiness(b.id, { locale_default: 'fr' as never, vertical: 'pirate' as never, refund_policy: 'whenever' as never, billing_interval: 'week' as never, refund_policy_text: 'x'.repeat(2001) });
      expect(same).toMatchObject({ locale_default: 'es', vertical: 'dental', refund_policy: 'full_48h', billing_interval: 'year', refund_policy_text: 'Cancel 48h before.' });
      expect((await db.updateBusiness(b.id, { refund_policy_text: '  ', voice_id: null, voice_name: null })).refund_policy_text).toBeNull();
      for (const data of [{ localeDefault: 'fr' }, { vertical: 'pirate' }, { refundPolicy: 'x' }, { billingInterval: 'week' }, { refundPolicyText: 'x'.repeat(2001) }]) {
        await fails(db.prisma.business.update({ where: { id: b.id }, data }));
      }
      const c = await biz({ locale_default: 'es', vertical: 'plumbing' });
      expect(c).toMatchObject({ locale_default: 'es', vertical: 'plumbing' });
    });

    test('user locale', async () => {
      const b = await biz();
      const u = await user('loc1', 'owner', b.id);
      expect((await db.getUserById(u.id)).locale).toBe('en');
      await db.setUserLocale(u.id, 'es');
      expect((await db.getUserById(u.id)).locale).toBe('es');
      expect((await db.listBusinessUsers(b.id))[0].locale).toBe('es');
      await expect(db.setUserLocale(u.id, 'de' as never)).rejects.toThrow();
      await fails(db.prisma.user.update({ where: { id: u.id }, data: { locale: 'de' } }));
    });
  });

  // ── bookings: reschedule, notification, refunds ────────────────────────────
  describe('bookings', () => {
    const mk = (businessId: string, when: Date, extra: Record<string, unknown> = {}) => db.createBooking({
      business_id: businessId, customer_name: 'Pat', customer_phone: '+13055550144', service: 'AC', scheduled_at: when.toISOString(), duration_minutes: 60, ...extra,
    });
    const expectReject = async (p: Promise<unknown>, reason: string) => {
      const err = await p.then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(db.BookingRejectedError);
      expect((err as any).reason).toBe(reason);
    };

    test('reschedule moves the same row atomically, counts, clears notification, and audits the previous time', async () => {
      const b = await biz();
      const k = await mk(b.id, at(3, 10));
      await db.markCustomerNotified(k.id);
      const r = await db.rescheduleBooking({ business_id: b.id, booking_id: k.id, scheduled_at: at(4, 14).toISOString(), duration_minutes: 90, actor: { kind: 'user', reason: 'customer asked' } });
      expect(r.changed).toBe(true);
      expect(r.previous).toEqual({ scheduled_at: at(3, 10).toISOString(), duration_minutes: 60 });
      expect(r.booking).toMatchObject({ id: k.id, scheduled_at: at(4, 14).toISOString(), duration_minutes: 90, reschedule_count: 1, customer_notified_at: null, status: 'confirmed' });
      const audit = await db.listAuditEvents({ business_id: b.id, action: 'booking.rescheduled' });
      expect(audit.length).toBe(1);
      expect(audit[0]).toMatchObject({ target: `booking:${k.id}`, actor_kind: 'user', meta: { from: at(3, 10).toISOString(), to: at(4, 14).toISOString(), previous_duration_minutes: 60, duration_minutes: 90, reschedule_count: 1, reason: 'customer asked' } });
      // the old slot is free again, the new one is taken
      expect((await mk(b.id, at(3, 10))).id).toBeTruthy();
      await expectReject(mk(b.id, at(4, 14, 30)), 'slot_taken');
      // no-op
      const same = await db.rescheduleBooking({ business_id: b.id, booking_id: k.id, scheduled_at: at(4, 14).toISOString() });
      expect(same.changed).toBe(false);
      expect(same.booking.reschedule_count).toBe(1);
      expect((await db.listAuditEvents({ business_id: b.id, action: 'booking.rescheduled' })).length).toBe(1);
    });

    test('rejections leave the booking untouched: overlap, hours, past, cancelled, other tenant, bad input', async () => {
      const b = await biz();
      const other = await biz();
      const k1 = await mk(b.id, at(3, 10));
      const k2 = await mk(b.id, at(3, 12));
      const before = await db.getBooking(k1.id);
      await expectReject(db.rescheduleBooking({ business_id: b.id, booking_id: k1.id, scheduled_at: at(3, 11, 30).toISOString() }), 'slot_taken'); // overlaps k2
      await expectReject(db.rescheduleBooking({ business_id: b.id, booking_id: k1.id, scheduled_at: at(3, 23).toISOString() }), 'after_close');
      await expectReject(db.rescheduleBooking({ business_id: b.id, booking_id: k1.id, scheduled_at: new Date(Date.now() - DAY).toISOString() }), 'past');
      await expectReject(db.rescheduleBooking({ business_id: b.id, booking_id: k1.id, scheduled_at: 'garbage' }), 'invalid_time');
      await expectReject(db.rescheduleBooking({ business_id: other.id, booking_id: k1.id, scheduled_at: at(5, 10).toISOString() }), 'booking_not_found');
      await expectReject(db.rescheduleBooking({ business_id: b.id, booking_id: 'missing', scheduled_at: at(5, 10).toISOString() }), 'booking_not_found');
      await expectReject(db.rescheduleBooking({ business_id: 'missing', booking_id: k1.id, scheduled_at: at(5, 10).toISOString() }), 'business_not_found');
      expect(await db.getBooking(k1.id)).toEqual(before);
      await db.transitionBooking(b.id, k2.id, 'cancelled', new Date(), { reason: 'customer cancelled' });
      await expectReject(db.rescheduleBooking({ business_id: b.id, booking_id: k2.id, scheduled_at: at(6, 10).toISOString() }), 'not_reschedulable');
      // a cancelled booking's slot no longer blocks, and enforce:false skips only the hours check
      expect((await db.rescheduleBooking({ business_id: b.id, booking_id: k1.id, scheduled_at: at(3, 12).toISOString() })).changed).toBe(true);
      expect((await db.rescheduleBooking({ business_id: b.id, booking_id: k1.id, scheduled_at: at(3, 23).toISOString() }, { enforce: false })).changed).toBe(true);
      expect(await db.prisma.auditEvent.count({ where: { businessId: b.id, action: 'booking.rescheduled' } })).toBe(2); // rejections write nothing
    });

    test('concurrent moves into the same slot: exactly one wins, the constraint is the backstop', async () => {
      const b = await biz();
      const ks = await Promise.all([10, 12, 14, 16].map((h) => mk(b.id, at(7, h))));
      const target = at(8, 10).toISOString();
      const rs = await Promise.allSettled(ks.map((k: any) => db.rescheduleBooking({ business_id: b.id, booking_id: k.id, scheduled_at: target })));
      expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
      expect(rs.filter((r: any) => r.status === 'rejected').every((r: any) => r.reason.reason === 'slot_taken')).toBe(true);
      expect(await db.prisma.booking.count({ where: { businessId: b.id, scheduledAt: new Date(target) } })).toBe(1);
      // the exclusion constraint still guards a raw update
      const loser = ks.find((k: any) => k.id !== (rs.find((r: any) => r.status === 'fulfilled') as any).value.booking.id);
      await fails(db.prisma.booking.update({ where: { id: loser.id }, data: { scheduledAt: new Date(target), durationMinutes: 60 } }));
    });

    test('cancel stores when and why; notification is stamped once; stripe refs are looked up both ways', async () => {
      const b = await biz();
      const k = await mk(b.id, at(3, 10), { stripe_payment_intent_id: `pi_${run}` });
      expect((await db.getBookingByStripeRef({ payment_intent_id: `pi_${run}` })).id).toBe(k.id);
      expect(await db.setBookingStripeRefs(k.id, { checkout_session_id: `cs_${run}` })).toBe(true);
      expect(await db.setBookingStripeRefs(k.id, {})).toBe(false);
      expect(await db.getBookingByStripeRef({ checkout_session_id: `cs_${run}` })).toMatchObject({ id: k.id, stripe_payment_intent_id: `pi_${run}`, stripe_checkout_session_id: `cs_${run}` });
      expect(await db.getBookingByStripeRef({})).toBeNull();
      expect(await db.getBookingByStripeRef({ payment_intent_id: 'pi_nope' })).toBeNull();
      const now = new Date();
      const t = await db.transitionBooking(b.id, k.id, 'cancelled', now, { reason: 'x'.repeat(600) });
      expect(t.ok && t.booking).toMatchObject({ status: 'cancelled', cancelled_at: now.toISOString() });
      expect((t.ok && t.booking.cancel_reason)?.length).toBe(500);
      expect(await db.markCustomerNotified(k.id)).toBe(true);
      expect(await db.markCustomerNotified(k.id)).toBe(false);
      expect(await db.markCustomerNotified(k.id, new Date(), { force: true })).toBe(true);
      expect((await db.getBooking(k.id)).customer_notified_at).not.toBeNull();
      // a transition without a reason leaves no reason
      const k2 = await mk(b.id, at(4, 10));
      const t2 = await db.transitionBooking(b.id, k2.id, 'cancelled');
      expect(t2.ok && t2.booking).toMatchObject({ cancel_reason: null });
    });

    test('refunds are idempotent and monotonic; failures never downgrade a refund', async () => {
      const b = await biz();
      const k = await mk(b.id, at(3, 10), { deposit_amount: 5000, deposit_paid: true });
      expect((await db.getBooking(k.id))).toMatchObject({ refund_status: 'none', refund_amount_cents: null, stripe_refund_id: null, refunded_at: null });
      expect((await db.recordRefund(k.id, { amount_cents: 0 })).updated).toBe(false);
      expect((await db.recordRefund(k.id, { amount_cents: 12.5 })).updated).toBe(false);
      expect((await db.recordRefund(k.id, { amount_cents: 5000, stripe_refund_id: 're_1', status: 'pending' })).booking).toMatchObject({ refund_status: 'pending', refund_amount_cents: 5000, refunded_at: null });
      expect((await db.markRefundFailed(k.id, 'card closed')).booking.refund_status).toBe('failed');
      expect((await db.recordRefund(k.id, { amount_cents: 5000, stripe_refund_id: 're_1' })).booking).toMatchObject({ refund_status: 'refunded', refund_amount_cents: 5000, stripe_refund_id: 're_1' });
      const done = await db.getBooking(k.id);
      expect(done.refunded_at).not.toBeNull();
      expect((await db.recordRefund(k.id, { amount_cents: 1, stripe_refund_id: 're_2' })).updated).toBe(false); // duplicate webhook
      expect((await db.markRefundFailed(k.id)).updated).toBe(false);
      expect(await db.getBooking(k.id)).toEqual(done);
      expect(await db.markRefundNotApplicable(k.id)).toBe(false);
      const k2 = await mk(b.id, at(4, 10));
      expect(await db.markRefundNotApplicable(k2.id)).toBe(true);
      expect((await db.recordRefund(k2.id, { amount_cents: 100 })).updated).toBe(true); // a later real refund still records
      expect((await db.recordRefund('missing', { amount_cents: 100 })).booking).toBeNull();
      await fails(db.prisma.booking.update({ where: { id: k.id }, data: { refundStatus: 'maybe' } }));
      await fails(db.prisma.booking.update({ where: { id: k2.id }, data: { refundStatus: 'refunded', refundAmountCents: null } }));
    });

    test('rebook lineage is a self reference that survives deleting the original', async () => {
      const b = await biz();
      const k1 = await mk(b.id, at(3, 10));
      const k2 = await mk(b.id, at(5, 10), { rescheduled_from_id: k1.id });
      expect((await db.getBooking(k2.id)).rescheduled_from_id).toBe(k1.id);
      await db.prisma.booking.delete({ where: { id: k1.id } });
      expect((await db.getBooking(k2.id)).rescheduled_from_id).toBeNull();
    });
  });
});
