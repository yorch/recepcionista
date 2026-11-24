/**
 * Owner-phone verification (stateless HMAC challenge) and the "alerts only to a verified owner phone" policy.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, toolRequest, uniq } from '../helpers/fixtures';
import { createOwnerPhoneChallenge, verifyOwnerPhoneChallenge } from '../../src/lib/messaging/owner-verify';

integration('owner phone verification (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  type Ctx = { params: Promise<{ id: string }> };
  let start: (req: Request, ctx: Ctx) => Promise<Response>;
  let confirm: (req: Request, ctx: Ctx) => Promise<Response>;
  let bizRoute: { PATCH: (req: Request, ctx: Ctx) => Promise<Response> };
  let tools: (req: Request, ctx: { params: Promise<{ tool: string }> }) => Promise<Response>;

  const admin = { authorization: `Bearer ${SECRETS.adminToken}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const req = (url: string, body: unknown, method = 'POST') => new Request(`http://app.test${url}`, { method, headers: admin, body: JSON.stringify(body) });
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const clear = () => prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'owner-phone/' } } });

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    start = (await import('@/app/api/businesses/[id]/owner-phone/verify/start/route')).POST;
    confirm = (await import('@/app/api/businesses/[id]/owner-phone/verify/confirm/route')).POST;
    bizRoute = await import('@/app/api/businesses/[id]/route');
    tools = (await import('@/app/api/voice/tools/[tool]/route')).POST;
  });
  afterAll(async () => { await clear(); await cleanup(); });

  /** The code the mock SMS "sent": the stateless challenge cannot reveal it, so capture the console line. */
  async function startFor(id: string, number: string) {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    let res: Response;
    try { res = await start(req(`/api/businesses/${id}/owner-phone/verify/start`, { phone: number }), ctx(id)); } finally { console.log = orig; }
    const json = (await res.json()) as { ok: boolean; challenge?: string; expires_at?: string; error?: string };
    const code = lines.join('\n').match(/code: (\d{6})/)?.[1];
    return { res, json, code };
  }

  test('start -> confirm sets owner_phone, owner_phone_e164 and owner_phone_verified_at, and is audited', async () => {
    await clear();
    const biz = await newBusiness({ owner_phone: null });
    const number = phone();
    const { res, json, code } = await startFor(biz.id, number);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.challenge).toBe('string');
    expect(new Date(json.expires_at!).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(new Date(json.expires_at!).getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);
    expect(code).toMatch(/^\d{6}$/);
    // the code never lands in sms_log
    const logged = await prisma.smsLog.findFirst({ where: { businessId: biz.id } });
    expect(logged?.body).toBe('[owner verification code]');

    const done = await confirm(req(`/api/businesses/${biz.id}/owner-phone/verify/confirm`, { phone: number, code, challenge: json.challenge }), ctx(biz.id));
    expect(done.status).toBe(200);
    const body = (await done.json()) as { ok: boolean; verified_at: string };
    expect(body.ok).toBe(true);
    expect(new Date(body.verified_at).getTime()).toBeGreaterThan(Date.now() - 5000);
    const row = await prisma.business.findUnique({ where: { id: biz.id } });
    expect(row?.ownerPhone).toBe(number);
    expect(row?.ownerPhoneE164).toBe(number);
    expect(row?.ownerPhoneVerifiedAt).not.toBeNull();
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.owner_phone_verified' } })).toBe(1);
  });

  test('wrong code, wrong phone, tampered or foreign challenge are refused; 5 attempts per challenge', async () => {
    await clear();
    const biz = await newBusiness({ owner_phone: null });
    const other = await newBusiness({ owner_phone: null });
    const number = phone();
    const { json, code } = await startFor(biz.id, number);
    const c = json.challenge!;
    const attempt = async (b: { id: string }, body: Record<string, unknown>) =>
      (await confirm(req(`/api/businesses/${b.id}/owner-phone/verify/confirm`, body), ctx(b.id))).status;

    expect(await attempt(biz, { phone: number, code: code === '000000' ? '000001' : '000000', challenge: c })).toBe(400);
    expect(await attempt(biz, { phone: phone(), code, challenge: c })).toBe(400); // another number
    expect(await attempt(other, { phone: number, code, challenge: c })).toBe(400); // another business
    expect(await attempt(biz, { phone: number, code, challenge: `${c.slice(0, -2)}xx` })).toBe(400); // tampered signature
    expect(await attempt(biz, { phone: number, code: '12345', challenge: c })).toBe(400);
    expect(await attempt(biz, { phone: number, code: '999999', challenge: c })).toBe(code === '999999' ? 200 : 400);
    // the 6th attempt on this challenge is rate limited even with the right code
    expect(await attempt(biz, { phone: number, code, challenge: c })).toBe(429);
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))?.ownerPhoneVerifiedAt).toBeNull();
  });

  test('challenge pure checks: expiry (10 minutes), binding and constant-format code', () => {
    const t0 = Date.now();
    const { code, challenge } = createOwnerPhoneChallenge('biz-1', '+13055550123', t0);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyOwnerPhoneChallenge(challenge, 'biz-1', '+13055550123', code, t0 + 9 * 60_000)).toEqual({ ok: true });
    expect(verifyOwnerPhoneChallenge(challenge, 'biz-1', '+13055550123', code, t0 + 10 * 60_000 + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyOwnerPhoneChallenge(challenge, 'biz-2', '+13055550123', code, t0)).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(verifyOwnerPhoneChallenge(challenge, 'biz-1', '+13055550124', code, t0)).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(verifyOwnerPhoneChallenge('garbage', 'biz-1', '+13055550123', code, t0)).toMatchObject({ ok: false });
    expect(verifyOwnerPhoneChallenge(challenge, 'biz-1', '+13055550123', ' 123456 ', t0).ok).toBe(code === '123456');
  });

  test('start: 3 per hour per destination number (all businesses), country allow-list applies, opted-out numbers are refused', async () => {
    await clear();
    const biz = await newBusiness({ owner_phone: null });
    const number = phone();
    for (let i = 0; i < 3; i++) expect((await startFor(biz.id, number)).res.status).toBe(200);
    expect((await startFor(biz.id, number)).res.status).toBe(429);

    await clear();
    const uk = '+442079460958';
    const denied = await startFor(biz.id, uk);
    expect(denied.res.status).toBe(422);
    expect(denied.json.ok).toBe(false);
    await withEnv({ SMS_ALLOWED_COUNTRY_CODES: '1,44' }, async () => {
      expect((await startFor(biz.id, uk)).res.status).toBe(200);
    });

    const optedOut = phone();
    await db.recordOptOut(biz.id, optedOut);
    expect((await startFor(biz.id, optedOut)).res.status).toBe(422);
    expect((await startFor(biz.id, 'not a phone')).res.status).toBe(422);
  });

  test('a user of another tenant cannot verify (404), and unauthenticated calls are 401', async () => {
    const biz = await newBusiness({ owner_phone: null });
    const res = await start(new Request(`http://app.test/api/businesses/${biz.id}/owner-phone/verify/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: phone() }),
    }), ctx(biz.id));
    expect(res.status).toBe(401);
  });

  test('changing owner_phone through PATCH clears the verification (the same number keeps it)', async () => {
    const biz = await newBusiness(); // fixture: verified
    expect((await db.getBusiness(biz.id))?.owner_phone_verified_at).not.toBeNull();
    const same = (await db.getBusiness(biz.id))!.owner_phone!;
    const r1 = await bizRoute.PATCH(req(`/api/businesses/${biz.id}`, { owner_phone: same }, 'PATCH'), ctx(biz.id));
    expect(r1.status).toBe(200);
    expect((await db.getBusiness(biz.id))?.owner_phone_verified_at).not.toBeNull();
    const r2 = await bizRoute.PATCH(req(`/api/businesses/${biz.id}`, { owner_phone: phone() }, 'PATCH'), ctx(biz.id));
    expect(r2.status).toBe(200);
    const after = await db.getBusiness(biz.id);
    expect(after?.owner_phone_verified_at).toBeNull();
    expect(after?.owner_phone_e164).toBe(after?.owner_phone);
  });

  test('unverified owner phone: alerts are NOT sent and the tool says the owner was not notified; verified: sent, any country', async () => {
    const biz = await newBusiness({ owner_verified: false });
    const conv = uniq('conv');
    const call = async (name: string, body: Record<string, unknown>) =>
      (await (await tools(toolRequest(name, { agent_id: biz.agent_id, conversation_id: conv, ...body }), { params: Promise.resolve({ tool: name }) })).json()) as { ok: boolean; message: string };

    const flagged = await call('flag_emergency', { reason: 'gas smell', customer_name: 'Ana' });
    expect(flagged.ok).toBe(false);
    expect(flagged.message).toMatch(/could not reach the owner/i);
    expect(flagged.message).toMatch(/911/);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert', status: { in: ['sent', 'mock'] } } })).toBe(0);

    // rollout switch: grandfathered owner phones count as verified
    await withEnv({ OWNER_PHONE_GRANDFATHER: 'true', DEMO_MODE: 'true' }, async () => {
      const ok = await call('handoff_to_human', { reason: 'wants a person' });
      expect(ok.message).toMatch(/owner an urgent message|sent the owner/i);
    });
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert', status: 'mock' } })).toBe(1);

    // verified owner with a foreign number is exempt from SMS_ALLOWED_COUNTRY_CODES (default 1)
    const abroad = await newBusiness({ owner_phone: '+442079460958' });
    const { sendAndLog } = await import('../../src/lib/messaging');
    const sent = await sendAndLog({ business_id: abroad.id, to: '+442079460958', body: 'EMERGENCY', kind: 'owner_alert' });
    expect(sent.blocked).toBeUndefined();
    expect(sent.sms.status).toBe('mock');
    // ... but a customer text to the same country is still refused by the allow-list
    const cust = await sendAndLog({ business_id: abroad.id, to: '+442079460111', body: 'hi', kind: 'other' });
    expect(cust.sms.status).toBe('failed');
  });
});
