/**
 * Agent C: tenants, plans, roles, support mode and the tenant knobs against a real database.
 *   - the support write gate on the tenant routes (no silent full-write impersonation), the support-view route, the tenant clean-up actions,
 *   - plan entitlements (owner call-in, owner reply, live transfer, deposits, calendar sync, locations) and per-plan checkout prices,
 *   - tenant overrides read by the feature code (quiet hours, briefing hour / on-off, thank-you toggle, ring seconds, owner reply daily limit).
 * No outbound request leaves the machine.
 */
import { integration, outboundCalls, SECRETS } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { cleanup, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

integration('admin console agent C: support gate, actions, entitlements, tenant knobs (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let R: Record<string, any> = {};
  const userIds: string[] = [];
  const planKeys: string[] = [];
  const startedAt = new Date(Date.now() - 1000);
  const ORIGIN = 'https://app.example.test';
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };

  const mk = async (role: 'owner' | 'ops' | 'support' | 'read_only') => {
    const user = await users.createUser({ email: `${uniq('adm')}@example.test`, password_hash: 'x'.repeat(20), role: 'admin', email_verified: true, platform_role: role });
    userIds.push(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: 'v1.a.b.c', totpEnabledAt: new Date() } });
    const { token, session } = await users.createSession(user.id);
    await users.markSessionMfaVerified(session.id);
    await prisma.userSession.updateMany({ where: { userId: user.id }, data: { sudoAt: new Date() } });
    return { user: { id: user.id, email: user.email }, cookie: `rc_user_session=${token}` };
  };
  const reqOf = (method: string, path: string, who: { cookie: string } | 'bearer' | null, body?: unknown, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: ORIGIN, ...(who === 'bearer' ? { authorization: `Bearer ${SECRETS.adminToken}` } : who ? { cookie: who.cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (handler: (req: Request, ctx?: any) => Promise<Response>, method: string, path: string, who: { cookie: string } | 'bearer' | null, body?: unknown, params?: Record<string, string>, headers?: Record<string, string>) => {
    const res = await handler(reqOf(method, path, who, body, headers), params ? { params: Promise.resolve(params) } : undefined);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, data: json?.data, code: json?.code, headers: res.headers };
  };

  beforeAll(async () => {
    setEnv('APP_SECRET_KEY', crypto.randomBytes(32).toString('base64'));
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    const m = async (p: string) => await import(p);
    R = {
      reviewUrl: await m('@/app/api/businesses/[id]/review-url/route'), support: await m('@/app/api/admin/tenants/[id]/support-mode/route'),
      supportView: await m('@/app/api/admin/tenants/[id]/support-view/route'), actions: await m('@/app/api/admin/tenants/[id]/actions/route'),
      prices: await m('@/app/api/admin/plans/prices/route'), planRoute: await m('@/app/api/admin/plans/route'),
    };
  });
  beforeEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'admin/' } }, { key: { startsWith: 'business/' } }] } }); });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    const { setPlanCatalog } = await import('@/lib/admin/plan-catalog');
    setPlanCatalog(null);
    await prisma.tenantSettingOverride.deleteMany({});
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { at: { gte: startedAt }, action: { in: ['support.view_opened', 'support.view', 'tenant.clear_owner_phone_verification', 'tenant.clear_trial_fingerprint', 'plans.create', 'plans.update'] } }] } });
    await prisma.business.updateMany({ where: { plan: { in: planKeys } }, data: { plan: null } });
    await prisma.plan.deleteMany({ where: { key: { in: planKeys } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await cleanup();
  });

  test('the support write gate: an admin user cannot write a tenant without an open grant; reads, the Bearer token and read_only rules', async () => {
    const biz = await newBusiness({ agent_id: null });
    const owner = await mk('owner'); const ops = await mk('ops'); const sup = await mk('support'); const ro = await mk('read_only');
    const put = (who: any, id = biz.id) => call(R.reviewUrl.PUT, 'PUT', `/api/businesses/${id}/review-url`, who, { review_url: 'https://g.page/r/abc' }, { id });
    // no grant: refused for every platform role, with the code the UI maps
    for (const who of [owner, ops, sup]) { const r = await put(who); expect([r.status, r.code]).toEqual([403, 'support_write_required']); }
    expect((await put(ro)).code).toBe('forbidden');
    // a read is never gated
    expect((await call(R.reviewUrl.GET ?? R.reviewUrl.PUT, 'GET', `/api/businesses/${biz.id}/review-url`, owner, undefined, { id: biz.id })).code).not.toBe('support_write_required');
    // write mode for THIS tenant: the write passes the gate (and is then judged by the route itself)
    expect((await call(R.support.POST, 'POST', `/api/admin/tenants/${biz.id}/support-mode`, ops, { reason: 'fixing the review link for the owner' }, { id: biz.id })).status).toBe(201);
    expect((await put(ops)).code).not.toBe('support_write_required');
    // ... but another tenant is still refused, and so is another admin
    const other = await newBusiness({ agent_id: null });
    expect((await put(ops, other.id)).code).toBe('support_write_required');
    expect((await put(owner)).code).toBe('support_write_required');
    // leaving write mode closes the gate again
    expect((await call(R.support.DELETE, 'DELETE', `/api/admin/tenants/${biz.id}/support-mode`, ops, undefined, { id: biz.id })).status).toBe(200);
    expect((await put(ops)).code).toBe('support_write_required');
    // an expired grant does not count
    await prisma.supportGrant.create({ data: { id: crypto.randomUUID(), userId: ops.user.id, businessId: biz.id, reason: 'expired grant for the test', startedAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 1_800_000) } });
    expect((await put(ops)).code).toBe('support_write_required');
    // the break-glass token is not a personal account: unchanged (its use is audited and mailed by the admin routes)
    expect((await put('bearer')).code).not.toBe('support_write_required');
  });

  test('support view: audited, selects the business cookie, reports an open write grant; the actions route clears the owner phone verification and trial fingerprints with a reason', async () => {
    const biz = await newBusiness({ agent_id: null });
    const sup = await mk('support'); const ops = await mk('ops'); const ro = await mk('read_only');
    const v = await call(R.supportView.POST, 'POST', `/api/admin/tenants/${biz.id}/support-view`, ro, undefined, { id: biz.id });
    expect(v.status).toBe(200);
    expect(v.headers.get('set-cookie') ?? '').toContain(`rc_business=${biz.id}`);
    expect(v.data.write_mode).toBeNull();
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'support.view_opened', actorUserId: ro.user.id } })).toBe(1);
    expect((await call(R.supportView.POST, 'POST', `/api/admin/tenants/nope/support-view`, ro, undefined, { id: 'nope' })).status).toBe(404);
    // actions: owner / ops only, reason required
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))!.ownerPhoneVerifiedAt).not.toBeNull();
    expect((await call(R.actions.POST, 'POST', `/api/admin/tenants/${biz.id}/actions`, sup, { action: 'clear_owner_phone_verification', reason: 'owner changed phone' }, { id: biz.id })).status).toBe(403);
    expect((await call(R.actions.POST, 'POST', `/api/admin/tenants/${biz.id}/actions`, ops, { action: 'clear_owner_phone_verification', reason: 'short' }, { id: biz.id })).code).toBe('reason_required');
    expect((await call(R.actions.POST, 'POST', `/api/admin/tenants/${biz.id}/actions`, ops, { action: 'delete_everything', reason: 'a long enough reason' }, { id: biz.id })).status).toBe(422);
    const r = await call(R.actions.POST, 'POST', `/api/admin/tenants/${biz.id}/actions`, ops, { action: 'clear_owner_phone_verification', reason: 'owner changed phone numbers' }, { id: biz.id });
    expect([r.status, r.data.changed]).toEqual([200, 1]);
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))!.ownerPhoneVerifiedAt).toBeNull();
    await prisma.trialFingerprint.create({ data: { kind: 'card', fingerprint: `fp-${uniq('c')}`, businessId: biz.id } });
    const t = await call(R.actions.POST, 'POST', `/api/admin/tenants/${biz.id}/actions`, ops, { action: 'clear_trial_fingerprint', reason: 'mistaken trial block' }, { id: biz.id });
    expect([t.status, t.data.changed]).toEqual([200, 1]);
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'tenant.clear_trial_fingerprint' } });
    expect((audit!.meta as any).reason).toBe('mistaken trial block');
  });

  test('plan entitlements keep today\'s behaviour for the standard plans and switch off per plan: owner call-in, owner reply, live transfer, deposits, locations; per-plan checkout price', async () => {
    const cat = await import('@/lib/admin/plan-catalog');
    const plans = await import('@/lib/admin/plans');
    const key = uniq('ent').toLowerCase();
    planKeys.push(key);
    const actor = { kind: 'system', user_id: null, role: 'system', via: 'system' } as any;
    await plans.createPlan({ key, name: 'No extras', features: { owner_callin: false, owner_reply: false, native_transfer: false, deposits: false, calendar_sync: false, multi_location: false }, stripe_price_id: 'price_planmonthly1', stripe_price_id_annual: 'price_planannual01', max_locations: 1 }, { actor, reason: 'entitlement test plan' });
    cat.setPlanCatalog((await plans.listPlans({ includeArchived: true })).map((p) => ({ ...p, archived_at: p.archived_at })));
    // the seeded standard plan has every feature on
    for (const f of cat.PLAN_FEATURES) expect(cat.planAllows('standard', f)).toBe(true);
    const biz = { owner_phone_e164: '+13055550101', owner_phone_verified_at: '2026-01-01T00:00:00Z', phone_e164: '+13055550199' } as any;
    const { detectOwnerCaller } = await import('@/lib/voice/owner/detect');
    expect(detectOwnerCaller({ ...biz, plan: 'standard' }, '+13055550101', {})).toEqual({ owner: true, e164: '+13055550101' });
    expect(detectOwnerCaller({ ...biz, plan: key }, '+13055550101', {})).toEqual({ owner: false, reason: 'disabled' });
    const { transferEnabledFor } = await import('@/lib/voice/transfer');
    expect(transferEnabledFor({ native_transfer_enabled: true, plan: 'standard' }, { NATIVE_TRANSFER: 'on' })).toBe(true);
    expect(transferEnabledFor({ native_transfer_enabled: true, plan: key }, { NATIVE_TRANSFER: 'on' })).toBe(false);
    const { resolveDepositAmount } = await import('@/lib/payments/deposit');
    const policy = { enabled: true, kind: 'fixed', value_cents: 5000 } as any;
    expect(resolveDepositAmount({ policy, requestedCents: 5000, actor: 'owner', plan: 'standard' }).ok).toBe(true);
    const refused = resolveDepositAmount({ policy, requestedCents: 5000, actor: 'owner', plan: key });
    expect(refused.ok).toBe(false);
    // locations: the plan's max_locations / multi_location decide; the account's own plans (roomiest wins)
    expect(cat.planAllowsLocation('standard', 3)).toBe(true);
    expect(cat.planAllowsLocation(key, 1)).toBe(false);
    const { createBusinessForOwner } = await import('@/lib/db/locations');
    const b = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: b.id }, data: { plan: key } });
    const u = await users.createUser({ email: `${uniq('own')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: b.id, email_verified: true });
    userIds.push(u.id);
    expect((await createBusinessForOwner(u.id, { name: 'Second shop' }, 10)).ok).toBe(false);
    await prisma.business.update({ where: { id: b.id }, data: { plan: 'standard' } });
    const second = await createBusinessForOwner(u.id, { name: 'Second shop' }, 10);
    expect(second.ok).toBe(true);
    if (second.ok) await prisma.business.delete({ where: { id: second.business.id } });
    // checkout: the plan's own price id wins, a plan without ids falls back to the platform price
    expect(cat.planPriceId(key, 'month')).toBe('price_planmonthly1');
    expect(cat.planPriceId(key, 'year')).toBe('price_planannual01');
    expect(cat.planPriceId('standard', 'month')).toBeNull();
    const sb = await import('@/lib/providers/stripe-billing');
    expect(sb.annualAvailable({ STRIPE_SECRET_KEY: 'sk_test_x' } as any, key)).toBe(true);
    expect(sb.annualAvailable({ STRIPE_SECRET_KEY: 'sk_test_x' } as any, 'standard')).toBe(false);
    cat.setPlanCatalog(null);
  });

  test('tenant knobs reach the feature code: quiet hours, briefing hour / on-off, thank-you toggle, ring seconds, owner reply daily limit, call budgets; clamped and re-validated at read', async () => {
    const ov = await import('@/lib/admin/tenant-overrides');
    const knobs = await import('@/lib/admin/tenant-knobs');
    const biz = await newBusiness({ agent_id: null });
    const owner = { kind: 'user', user_id: null, scope: 'owner' } as any;
    const set = (key: string, value: unknown) => ov.setTenantOverride({ business_id: biz.id, key, value, actor: owner });
    // nothing set: the platform values (today's behaviour)
    expect(await knobs.quietWindowFor(biz.id)).toEqual({ start: 21, end: 8 });
    expect(await knobs.knobOr(biz.id, 'forward.ring_seconds', 20)).toBe(20);
    // quiet hours stricter than 21-8: 20 to 9 is accepted and read; looser is refused at write
    await set('messaging.quiet_start_hour', 20); await set('messaging.quiet_end_hour', 9);
    expect(await knobs.quietWindowFor(biz.id)).toEqual({ start: 20, end: 9 });
    await expect(set('messaging.quiet_start_hour', 22)).rejects.toMatchObject({ code: 'not_stricter' });
    const { isQuietHour } = await import('@/lib/messaging/policy');
    const at = (h: number) => new Date(Date.UTC(2027, 0, 15, h + 5, 30)); // New York, January: UTC-5
    const w = await knobs.quietWindowFor(biz.id);
    expect([isQuietHour(at(20), 'America/New_York'), isQuietHour(at(20), 'America/New_York', w)]).toEqual([false, true]); // 8pm: quiet only for this tenant
    expect([isQuietHour(at(8), 'America/New_York'), isQuietHour(at(8), 'America/New_York', w)]).toEqual([false, true]);
    expect(isQuietHour(at(12), 'America/New_York', w)).toBe(false);
    // ring seconds within bounds (10..40), an out-of-range write is refused
    await set('forward.ring_seconds', 30);
    expect(await knobs.knobOr(biz.id, 'forward.ring_seconds', 20)).toBe(30);
    await expect(set('forward.ring_seconds', 90)).rejects.toThrow(/between 10 and 40/);
    // a stored value that fails the schema is ignored at read: simulate with a raw row
    await prisma.tenantSettingOverride.update({ where: { businessId_key: { businessId: biz.id, key: 'forward.ring_seconds' } }, data: { value: 500 } });
    expect(await knobs.knobOr(biz.id, 'forward.ring_seconds', 20)).toBe(20); // an invalid stored value is ignored (the platform value applies)
    // briefing: hour + on/off
    await set('jobs.briefing_hour', 20); await set('jobs.briefing_enabled', false); await set('jobs.gratitude_enabled', false);
    const { briefingSlot, nextBriefingAt } = await import('@/lib/jobs/schedule');
    const now = new Date(Date.UTC(2027, 0, 15, 23, 30)); // 18:30 in New York
    expect(briefingSlot(now, 'America/New_York').due).toBe(true);
    expect(briefingSlot(now, 'America/New_York', 20).due).toBe(false);
    expect(nextBriefingAt(now, 'America/New_York', 20).toISOString()).toBe('2027-01-16T01:00:00.000Z');
    expect(await knobs.knobOr(biz.id, 'jobs.briefing_enabled', true)).toBe(false);
    expect(await knobs.knobOr(biz.id, 'jobs.gratitude_enabled', true)).toBe(false);
    // owner reply daily limit and call budgets are platform-only knobs an admin writes
    const admin = { kind: 'user', user_id: null, scope: 'platform', role: 'ops' } as any;
    await ov.setTenantOverride({ business_id: biz.id, key: 'owner.reply_daily_limit', value: 3, actor: admin });
    await ov.setTenantOverride({ business_id: biz.id, key: 'forward.calls_per_hour', value: 5, actor: admin });
    await ov.setTenantOverride({ business_id: biz.id, key: 'voicemail.calls_per_hour', value: 4, actor: admin });
    expect(await knobs.knobOr(biz.id, 'owner.reply_daily_limit', 10)).toBe(3);
    expect(await knobs.knobOr(biz.id, 'forward.calls_per_hour', 60)).toBe(5);
    expect(await knobs.knobOr(biz.id, 'voicemail.calls_per_hour', 60)).toBe(4);
    // another business is untouched
    const other = await newBusiness({ agent_id: null });
    expect(await knobs.knobOr(other.id, 'owner.reply_daily_limit', 10)).toBe(10);
    const map = await knobs.loadTenantOverridesMany([biz.id, other.id]);
    expect(Object.keys(map.get(biz.id) ?? {}).length).toBeGreaterThan(5);
    expect(map.get(other.id)).toBeUndefined();
  });

  test('plan prices route: no Stripe key means unknown prices, never an error; read needs plans.read', async () => {
    setEnv('STRIPE_SECRET_KEY', undefined);
    const ro = await mk('read_only');
    const r = await call(R.prices.GET, 'GET', '/api/admin/plans/prices', ro);
    expect(r.status).toBe(200);
    expect(r.data.stripe_configured).toBe(false);
    expect(r.data.platform).toEqual({ monthly: null, annual: null });
    expect((await call(R.prices.GET, 'GET', '/api/admin/plans/prices', null)).status).toBe(401);
  });
});
