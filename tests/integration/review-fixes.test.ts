/**
 * Adversarial-review fixes against a real database: the support write gate (grant for tenant A never authorises tenant B, whatever supplied the business id; the support role is not
 * owner write; creating and provisioning tenants need a platform permission), the break-glass token and owners, the legal publish review, typed phrases on the server, suspended
 * tenants in the job runner, tenant cap overrides, plan features, owner switches, and the admin-chosen password rule. No outbound request leaves the machine.
 */
import { integration, outboundCalls, SECRETS } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

integration('review fixes: support gate, platform actions, phrases, jobs, caps, plan features (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let db: Awaited<ReturnType<typeof loadDb>>;
  let users: typeof import('@/lib/db/users');
  let R: Record<string, any> = {};
  const userIds: string[] = [];
  const planKeys: string[] = [];
  const createdBusinesses: string[] = [];
  const startedAt = new Date(Date.now() - 1000);
  const ORIGIN = 'https://app.example.test';
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  type Who = { cookie: string; user: { id: string; email: string } };

  const mk = async (role: 'owner' | 'ops' | 'support' | 'read_only'): Promise<Who> => {
    const user = await users.createUser({ email: `${uniq('adm')}@example.test`, password_hash: 'x'.repeat(20), role: 'admin', email_verified: true, platform_role: role });
    userIds.push(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: 'v1.a.b.c', totpEnabledAt: new Date() } });
    const { token, session } = await users.createSession(user.id);
    await users.markSessionMfaVerified(session.id);
    await prisma.userSession.updateMany({ where: { userId: user.id }, data: { sudoAt: new Date() } });
    return { user: { id: user.id, email: user.email }, cookie: `rc_user_session=${token}` };
  };
  const reqOf = (method: string, path: string, who: Who | 'bearer' | null, body?: unknown, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: ORIGIN, ...(who === 'bearer' ? { authorization: `Bearer ${SECRETS.adminToken}` } : who ? { cookie: who.cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (handler: (req: Request, ctx?: any) => Promise<Response>, method: string, path: string, who: Who | 'bearer' | null, body?: unknown, params?: Record<string, string>, headers?: Record<string, string>) => {
    const res = await handler(reqOf(method, path, who, body, headers), params ? { params: Promise.resolve(params) } : undefined);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, data: json?.data, code: json?.code, headers: res.headers };
  };
  const enter = (who: Who, bizId: string) => call(R.support.POST, 'POST', `/api/admin/tenants/${bizId}/support-mode`, who, { reason: 'review fix test: acting for the tenant' }, { id: bizId });
  const booking = async (businessId: string) => (await prisma.booking.create({ data: { businessId, customerName: 'Walk In', customerPhone: '+13055550111', service: 'AC repair', scheduledAt: new Date(Date.now() + 5 * 86_400_000), durationMinutes: 60, status: 'confirmed' } })).id;

  beforeAll(async () => {
    setEnv('APP_SECRET_KEY', crypto.randomBytes(32).toString('base64'));
    for (const k of ['ADMIN_TOKEN_ALLOW_SETTINGS', 'BILLING_ENFORCED', 'PLAN_SMS_CAP', 'PLAN_CALL_MINUTES_CAP', 'FORWARD_MINUTES_CAP', 'VOICEMAIL_MINUTES_CAP']) setEnv(k, undefined);
    prisma = await loadPrisma(); db = await loadDb();
    users = await import('@/lib/db/users');
    const m = async (p: string) => await import(p);
    R = {
      support: await m('@/app/api/admin/tenants/[id]/support-mode/route'), suspend: await m('@/app/api/admin/tenants/[id]/suspend/route'),
      invite: await m('@/app/api/team/invite/route'), refund: await m('@/app/api/bookings/[id]/refund/route'), reschedule: await m('@/app/api/bookings/[id]/reschedule/route'),
      bookings: await m('@/app/api/bookings/route'), smsSend: await m('@/app/api/sms/send/route'), smsGratitude: await m('@/app/api/sms/gratitude/route'), smsConfirmation: await m('@/app/api/sms/confirmation/route'),
      erase: await m('@/app/api/privacy/erase/route'), extract: await m('@/app/api/extract/route'), briefingGen: await m('@/app/api/briefings/generate/route'), gratitudeRun: await m('@/app/api/gratitude/run/route'),
      reviewUrl: await m('@/app/api/businesses/[id]/review-url/route'), businesses: await m('@/app/api/businesses/route'), provision: await m('@/app/api/businesses/[id]/provision/route'),
      adminUsers: (await m('@/app/api/admin/users/route')).POST, admins: await m('@/app/api/admin/admins/route'), twoFactor: await m('@/app/api/admin/admins/[id]/two-factor/route'),
      legalPage: await m('@/app/api/admin/legal/[slug]/[locale]/route'), legalPublish: await m('@/app/api/admin/legal/[slug]/[locale]/publish/route'),
      release: (await m('@/app/api/admin/release-tenant/route')).POST, jobsRun: (await m('@/app/api/admin/jobs/run/route')).POST,
    };
  });
  beforeEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'admin/' } }, { key: { startsWith: 'business/' } }, { key: { startsWith: 'team/' } }] } }); });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    const { setPlanCatalog } = await import('@/lib/admin/plan-catalog');
    setPlanCatalog(null);
    await prisma.tenantSettingOverride.deleteMany({});
    await prisma.legalPageVersion.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await prisma.legalPage.updateMany({ data: { publishedVersion: null } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { at: { gte: startedAt }, action: { in: ['admin.invited', 'admin.bearer_use', 'plans.registered', 'legal.published', 'legal.draft_saved', 'tenant.suspended', 'support.write_mode_entered'] } }] } });
    await prisma.business.updateMany({ where: { plan: { in: planKeys } }, data: { plan: null } });
    await prisma.plan.deleteMany({ where: { key: { in: planKeys } } });
    await prisma.emailToken.deleteMany({ where: { businessId: { in: createdBusinesses } } });
    await prisma.business.deleteMany({ where: { id: { in: createdBusinesses } } });
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: userIds } }, { email: { contains: '@review-fix.test' } }] } });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await cleanup();
  });

  // ---- H1 ------------------------------------------------------------------------------------------------------------------------------------

  test('H1: a grant for tenant A never authorises tenant B, whether B comes from the body, the resource, the query or a cookie', async () => {
    const A = await newBusiness({ agent_id: null }); const B = await newBusiness({ agent_id: null });
    const ops = await mk('ops'); const owner = await mk('owner');
    expect((await enter(ops, A.id)).status).toBe(201);
    const bookingB = await booking(B.id); const bookingA = await booking(A.id);
    const refused = (r: { status: number; code: string }) => [r.status, r.code];

    // body-supplied business id: the reported exploit (an owner invite for B with a grant for A)
    const evil = await call(R.invite.POST, 'POST', '/api/team/invite', ops, { email: `x-${uniq('i')}@review-fix.test`, role: 'owner', business_id: B.id });
    expect(refused(evil)).toEqual([403, 'support_write_required']);
    expect(await prisma.emailToken.count({ where: { businessId: B.id } })).toBe(0);
    // the same request for A passes the gate (the route then judges it: it may fail on mail, never on the gate)
    const fine = await call(R.invite.POST, 'POST', '/api/team/invite', ops, { email: `y-${uniq('i')}@review-fix.test`, role: 'staff', business_id: A.id });
    expect(['support_write_required', 'support_scope', 'forbidden']).not.toContain(fine.code);
    await prisma.emailToken.deleteMany({ where: { businessId: A.id } });

    // body-supplied, every route that reads business_id from the body
    for (const [name, handler, path, body] of [
      ['bookings', R.bookings.POST, '/api/bookings', { business_id: B.id, customer_name: 'X', customer_phone: '+13055550112', service: 'AC repair', scheduled_at: new Date(Date.now() + 9 * 86_400_000).toISOString() }],
      ['sms send', R.smsSend.POST, '/api/sms/send', { business_id: B.id, to: '+13055550112', body: 'hi' }],
      ['extract', R.extract.POST, '/api/extract', { business_id: B.id, text: 'hello' }],
      ['erase', R.erase.POST, '/api/privacy/erase', { business_id: B.id, phone: '+13055550112' }],
      ['briefing', R.briefingGen.POST, '/api/briefings/generate', { business_id: B.id }],
    ] as const) {
      const r = await call(handler, 'POST', path, ops, body);
      expect([name, ...refused(r)]).toEqual([name, 403, 'support_write_required']);
    }
    // resource-derived: the booking belongs to B
    for (const [name, handler, path, params, body] of [
      ['refund', R.refund.POST, `/api/bookings/${bookingB}/refund`, { id: bookingB }, {}],
      ['reschedule', R.reschedule.POST ?? R.reschedule.PATCH, `/api/bookings/${bookingB}/reschedule`, { id: bookingB }, { scheduled_at: new Date(Date.now() + 8 * 86_400_000).toISOString() }],
      ['sms gratitude', R.smsGratitude.POST, '/api/sms/gratitude', undefined, { booking_id: bookingB }],
      ['sms confirmation', R.smsConfirmation.POST, '/api/sms/confirmation', undefined, { booking_id: bookingB }],
    ] as const) {
      const r = await call(handler, 'POST', path, ops, body, params as any);
      expect([name, ...refused(r)]).toEqual([name, 403, 'support_write_required']);
    }
    // ... and the booking of A is judged by its route, not refused by the gate
    const own = await call(R.smsConfirmation.POST, 'POST', '/api/sms/confirmation', ops, { booking_id: bookingA });
    expect(['support_write_required', 'support_scope']).not.toContain(own.code);
    // a global run that names no business is not a tenant write an admin user may make
    expect(refused(await call(R.gratitudeRun.POST, 'POST', '/api/gratitude/run', ops, {}))).toEqual([403, 'support_write_required']);
    // query string and path name B: refused by the early gate
    expect(refused(await call(R.bookings.POST, 'POST', `/api/bookings?business_id=${B.id}`, ops, { business_id: A.id }))).toEqual([403, 'support_write_required']);
    expect(refused(await call(R.reviewUrl.PUT, 'PUT', `/api/businesses/${B.id}/review-url`, ops, { review_url: 'https://g.page/r/abc' }, { id: B.id }))).toEqual([403, 'support_write_required']);
    // cookie mismatch: the cookie says A (granted), the body says B -> refused; the cookie says B (not granted), the URL says A -> allowed through the gate
    expect(refused(await call(R.invite.POST, 'POST', '/api/team/invite', ops, { email: `z-${uniq('i')}@review-fix.test`, role: 'owner', business_id: B.id }, undefined, { cookie: `${ops.cookie}; rc_business=${A.id}` }))).toEqual([403, 'support_write_required']);
    const viaUrl = await call(R.smsSend.POST, 'POST', `/api/sms/send?business_id=${A.id}`, ops, { business_id: A.id, to: '+13055550112', body: 'hi' }, undefined, { cookie: `${ops.cookie}; rc_business=${B.id}` });
    expect(['support_write_required', 'support_scope']).not.toContain(viaUrl.code);
    // an admin with NO open grant at all is refused whatever the body says; the Bearer token is not a personal account and is unchanged
    expect(refused(await call(R.invite.POST, 'POST', '/api/team/invite', owner, { email: `w-${uniq('i')}@review-fix.test`, role: 'owner', business_id: A.id }))).toEqual([403, 'support_write_required']);
    const bearer = await call(R.invite.POST, 'POST', '/api/team/invite', 'bearer', { email: `v-${uniq('i')}@review-fix.test`, role: 'staff', business_id: A.id });
    expect(['support_write_required', 'support_scope', 'forbidden']).not.toContain(bearer.code);
    await prisma.emailToken.deleteMany({ where: { businessId: A.id } });
    // an expired grant authorises nothing, even for A
    await prisma.supportGrant.updateMany({ where: { userId: ops.user.id }, data: { expiresAt: new Date(Date.now() - 1000), startedAt: new Date(Date.now() - 31 * 60_000) } });
    expect(refused(await call(R.invite.POST, 'POST', '/api/team/invite', ops, { email: `u-${uniq('i')}@review-fix.test`, role: 'staff', business_id: A.id }))).toEqual([403, 'support_write_required']);
  });

  // ---- H2 ------------------------------------------------------------------------------------------------------------------------------------

  test('H2: support write mode is the documented scope, not owner write: no tenant route is open to the support role; owner and ops keep their behaviour', async () => {
    const A = await newBusiness({ agent_id: null });
    const sup = await mk('support'); const ops = await mk('ops'); const owner = await mk('owner');
    const bookingA = await booking(A.id);
    const probes: [string, string, any, Record<string, string> | undefined][] = [
      ['/api/team/invite', 'invite', { email: `s-${uniq('i')}@review-fix.test`, role: 'owner', business_id: A.id }, undefined],
      ['/api/privacy/erase', 'erase', { business_id: A.id, phone: '+13055550113' }, undefined],
      [`/api/bookings/${bookingA}/refund`, 'refund', {}, { id: bookingA }],
      ['/api/sms/send', 'smsSend', { business_id: A.id, to: '+13055550112', body: 'hi' }, undefined],
    ];
    // without a grant: support_write_required (unchanged contract); read_only: forbidden
    for (const [path, name, body, params] of probes) expect([name, (await call(R[name].POST, 'POST', path, sup, body, params)).code]).toEqual([name, 'support_write_required']);
    await enter(sup, A.id); await enter(ops, A.id); await enter(owner, A.id);
    // with a grant the support role is still refused every one of them: SUPPORT_WRITE_SCOPE is tenants.overrides.write and nothing else
    for (const [path, name, body, params] of probes) {
      const r = await call(R[name].POST, 'POST', path, sup, body, params);
      expect([name, r.status, r.code]).toEqual([name, 403, 'support_scope']);
    }
    expect((await call(R.reviewUrl.PUT, 'PUT', `/api/businesses/${A.id}/review-url`, sup, { review_url: 'https://g.page/r/abc' }, { id: A.id })).code).toBe('support_scope');
    expect(await prisma.emailToken.count({ where: { businessId: A.id } })).toBe(0);
    // ... while its documented write (the tenant knobs through the console) works, and owner / ops with a grant keep today's behaviour on tenant routes
    const knob = await call((await import('@/app/api/admin/tenant-overrides/route')).PUT as any, 'PUT', '/api/admin/tenant-overrides', sup, { business_id: A.id, key: 'forward.ring_seconds', value: 25 });
    expect(knob.status).toBe(200);
    for (const who of [ops, owner]) {
      const r = await call(R.reviewUrl.PUT, 'PUT', `/api/businesses/${A.id}/review-url`, who, { review_url: 'https://g.page/r/abc' }, { id: A.id });
      expect(['support_write_required', 'support_scope', 'forbidden']).not.toContain(r.code);
    }
  });

  // ---- H3 ------------------------------------------------------------------------------------------------------------------------------------

  test('H3: creating a tenant and provisioning need a platform permission (read_only and support cannot); provisioning needs a fresh sign-in', async () => {
    const ro = await mk('read_only'); const sup = await mk('support'); const ops = await mk('ops');
    const biz = await newBusiness({ agent_id: null });
    for (const who of [ro, sup]) {
      const c = await call(R.businesses.POST, 'POST', '/api/businesses', who, { name: `Nope ${uniq('b')}` });
      expect([c.status, c.code]).toEqual([403, 'forbidden']);
      const p = await call(R.provision.POST, 'POST', `/api/businesses/${biz.id}/provision`, who, {}, { id: biz.id });
      expect([p.status, p.code]).toEqual([403, 'forbidden']);
    }
    expect(await prisma.business.count({ where: { name: { startsWith: 'Nope ' } } })).toBe(0);
    expect(await prisma.business.findUnique({ where: { id: biz.id } }).then((b) => b?.phone ?? null)).toBe(biz.phone ?? null); // nothing was bought
    // ops may create a tenant (platform action: no tenant grant) ...
    const made = await call(R.businesses.POST, 'POST', '/api/businesses', ops, { name: `Ops made ${uniq('b')}` });
    expect(made.status).toBe(201);
    createdBusinesses.push(made.data.id);
    // ... and provisioning needs a step-up on top of the permission
    await prisma.userSession.updateMany({ where: { userId: ops.user.id }, data: { sudoAt: new Date(Date.now() - 20 * 60_000) } });
    const stale = await call(R.provision.POST, 'POST', `/api/businesses/${biz.id}/provision`, ops, {}, { id: biz.id });
    expect([stale.status, stale.code]).toEqual([403, 'reauth_required']);
    await prisma.userSession.updateMany({ where: { userId: ops.user.id }, data: { sudoAt: new Date() } });
    const fresh = await call(R.provision.POST, 'POST', `/api/businesses/${biz.id}/provision`, ops, {}, { id: biz.id });
    expect(['forbidden', 'reauth_required', 'support_write_required']).not.toContain(fresh.code); // no tenant grant needed: it is an operator action on the providers
  });

  // ---- M2 / L3 -------------------------------------------------------------------------------------------------------------------------------

  test('M2: the break-glass token creates an owner only when none is enabled or ADMIN_TOKEN_ALLOW_SETTINGS=true; other roles are unaffected', async () => {
    const { inviteAdmin } = await import('@/lib/admin/admins');
    const bearer: any = { kind: 'admin_token', user_id: null, via: 'bearer', role: 'bearer', ip: null };
    const mail = (t: string) => `${t}-${uniq('m')}@review-fix.test`;
    await mk('owner'); // an enabled owner exists
    const err = await inviteAdmin({ email: mail('o1'), platform_role: 'owner', password: 'correct horse battery 1', actor: bearer }).catch((e) => e);
    expect([err.status, err.code]).toEqual([403, 'owner_requires_owner']);
    expect((await inviteAdmin({ email: mail('o2'), platform_role: 'owner', actor: bearer }).catch((e) => e)).code).toBe('owner_requires_owner'); // an invite link would mint one too
    expect((await inviteAdmin({ email: mail('ops'), platform_role: 'ops', password: 'correct horse battery 2', actor: bearer })).admin.platform_role).toBe('ops');
    setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', 'true');
    expect((await inviteAdmin({ email: mail('o3'), platform_role: 'owner', password: 'correct horse battery 3', actor: bearer })).admin.platform_role).toBe('owner');
    setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', undefined);
    // lock-out recovery: no enabled owner at all
    const owners = await prisma.user.findMany({ where: { role: 'admin', platformRole: 'owner', disabledAt: null }, select: { id: true } });
    await prisma.user.updateMany({ where: { id: { in: owners.map((o) => o.id) } }, data: { disabledAt: new Date() } });
    try {
      expect((await inviteAdmin({ email: mail('o4'), platform_role: 'owner', password: 'correct horse battery 4', actor: bearer })).admin.platform_role).toBe('owner');
    } finally { await prisma.user.updateMany({ where: { id: { in: owners.map((o) => o.id) } }, data: { disabledAt: null } }); }
    const made = await prisma.user.findMany({ where: { email: { contains: '@review-fix.test' } }, select: { id: true } });
    userIds.push(...made.map((u) => u.id));
  });

  test('L3: an admin-chosen password for a tenant login needs an owner administrator (or the break-glass token); ops invites instead; every creation is audited', async () => {
    const biz = await newBusiness({ agent_id: null });
    const ops = await mk('ops'); const owner = await mk('owner'); const sup = await mk('support');
    const body = (t: string) => ({ email: `${t}-${uniq('u')}@review-fix.test`, password: 'correct horse battery', role: 'staff', business_id: biz.id });
    for (const who of [ops, sup]) { const r = await call(R.adminUsers, 'POST', '/api/admin/users', who, body('x')); expect([r.status, r.code]).toEqual([403, who === ops ? 'owner_required' : 'forbidden']); }
    expect(await prisma.user.count({ where: { businessId: biz.id } })).toBe(0);
    const r = await call(R.adminUsers, 'POST', '/api/admin/users', owner, body('ok'));
    expect(r.status).toBe(201);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'user.create', businessId: biz.id } });
    expect(audit.meta).toMatchObject({ role: 'staff', login_set_by_admin: true, admin_role: 'owner' });
    expect((await call(R.adminUsers, 'POST', '/api/admin/users', 'bearer', body('bear'))).status).toBe(201);
  });

  // ---- M4 / L1 -------------------------------------------------------------------------------------------------------------------------------

  test('M4: publishing names the reviewed draft (version + content hash): an edited draft is refused 409 draft_changed, never published silently', async () => {
    const owner = await mk('owner');
    const P = { slug: 'terms', locale: 'en' };
    const putDraft = (b: string) => call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', owner, { body: b }, P);
    const publish = (b: unknown) => call(R.legalPublish.POST, 'POST', '/api/admin/legal/terms/en/publish', owner, b, P);
    const d1 = await putDraft('# Terms\n\nfirst reviewed text');
    expect(d1.data.hash).toMatch(/^[0-9a-f]{64}$/);
    const ok = { reason: 'reviewed by counsel today', confirm: 'publish terms/en', version: d1.data.version, hash: d1.data.hash };
    // another admin edits the draft after the review
    const d2 = await putDraft('# Terms\n\nsomething nobody reviewed');
    expect(d2.data.version).toBe(d1.data.version); // the draft is edited in place
    expect(d2.data.hash).not.toBe(d1.data.hash);
    const stale = await publish(ok);
    expect([stale.status, stale.code]).toEqual([409, 'draft_changed']);
    expect(await prisma.legalPageVersion.count({ where: { slug: 'terms', locale: 'en', draft: true } })).toBe(1); // still a draft
    expect((await publish({ reason: ok.reason, confirm: ok.confirm })).code).toBe('review_required'); // no version / hash at all
    expect((await publish({ ...ok, version: d2.data.version, hash: d2.data.hash, confirm: 'publish terms' })).code).toBe('confirmation_required'); // the typed phrase (L1)
    expect((await publish({ ...ok, version: d2.data.version, hash: d2.data.hash, reason: 'short' })).code).toBe('reason_required');
    const done = await publish({ ...ok, version: d2.data.version, hash: d2.data.hash });
    expect(done.status).toBe(200);
    expect(done.data.version).toBe(d2.data.version);
    expect((await publish({ ...ok, version: d2.data.version, hash: d2.data.hash })).code).toBe('no_draft');
  });

  test('L1: suspend, release, a 2FA reset and a critical job run need their typed phrase and reason on the SERVER, in the format the console shows', async () => {
    const biz = await newBusiness({ agent_id: null, name: `Acme Phrase ${uniq('n')}` });
    const ops = await mk('ops'); const owner = await mk('owner'); const target = await mk('ops');
    const phrase = (verb: string) => `${verb} ${biz.name}`.toLowerCase();
    // suspend
    const sus = (b: unknown) => call(R.suspend.POST, 'POST', `/api/admin/tenants/${biz.id}/suspend`, ops, b, { id: biz.id });
    expect([(await sus({ reason: 'abuse reports from carriers' })).code]).toEqual(['confirmation_required']);
    expect((await sus({ reason: 'abuse reports from carriers', confirm: 'suspend' })).code).toBe('confirmation_required');
    expect((await sus({ reason: 'short', confirm: phrase('suspend') })).code).toBe('reason_required');
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))!.suspendedAt).toBeNull();
    expect((await sus({ reason: 'abuse reports from carriers', confirm: phrase('suspender').toUpperCase() })).status).toBe(200); // the Spanish verb, any case
    // release (a real run): reason, then phrase; a dry run needs neither
    const rel = (b: unknown) => call(R.release, 'POST', '/api/admin/release-tenant', ops, { business_id: biz.id, ...(b as object) });
    expect((await rel({ dry_run: true })).status).toBe(200);
    expect((await rel({ dry_run: false })).code).toBe('reason_required');
    expect((await rel({ dry_run: false, reason: 'the account was cancelled' })).code).toBe('confirmation_required');
    expect((await rel({ dry_run: false, reason: 'the account was cancelled', confirm: phrase('release') })).status).toBe(200); // not releasable (not canceled): a skip, but past the phrase
    // 2FA reset by e-mail
    const reset = (b: unknown) => call(R.twoFactor.DELETE, 'DELETE', `/api/admin/admins/${target.user.id}/two-factor`, owner, b, { id: target.user.id });
    expect((await reset({})).code).toBe('reason_required');
    expect((await reset({ reason: 'lost phone, verified by call' })).code).toBe('confirmation_required');
    expect((await reset({ reason: 'lost phone, verified by call', confirm: 'someone@else.test' })).code).toBe('confirmation_required');
    expect(await prisma.user.findUnique({ where: { id: target.user.id } }).then((u) => u?.totpEnabledAt !== null)).toBe(true);
    expect((await reset({ reason: 'lost phone, verified by call', confirm: target.user.email.toUpperCase() })).status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: target.user.id } }).then((u) => u?.totpEnabledAt)).toBeNull();
    // a critical job run for real: reason + `run <job>` (refusals only: nothing is purged here)
    const run = (b: unknown) => call(R.jobsRun, 'POST', '/api/admin/jobs/run', ops, { job: 'retention', dry_run: false, ...(b as object) });
    expect((await run({})).code).toBe('reason_required');
    expect((await run({ reason: 'scheduled purge review' })).code).toBe('confirmation_required');
    expect((await run({ reason: 'scheduled purge review', confirm: 'run cleanup' })).code).toBe('confirmation_required');
    await prisma.business.update({ where: { id: biz.id }, data: { suspendedAt: null, suspendedBy: null, suspendedReason: null } });
  });

  // ---- M6 ------------------------------------------------------------------------------------------------------------------------------------

  test('M6: a suspended tenant is skipped by the briefing and gratitude jobs and does not count as due', async () => {
    const jobs = await import('@/lib/jobs');
    const b = await newBusiness({ timezone: 'America/New_York' });
    await prisma.business.update({ where: { id: b.id }, data: { status: 'live', billingStatus: 'active' } });
    const other = await newBusiness({ timezone: 'America/New_York' });
    await prisma.business.update({ where: { id: other.id }, data: { status: 'live', billingStatus: 'active' } });
    const outcomes = async (job: 'daily_briefing' | 'gratitude_sweep', id: string) => (await jobs.runJob(job, { dryRun: true, force: true, businessId: id, trigger: 'manual', actor: 'test' } as any)).items.map((i: any) => i.outcome);
    expect(await outcomes('daily_briefing', b.id)).not.toContain('skipped_suspended');
    await prisma.business.update({ where: { id: b.id }, data: { suspendedAt: new Date(), suspendedBy: 'u', suspendedReason: 'abuse' } });
    expect(await outcomes('daily_briefing', b.id)).toEqual(['skipped_suspended']);
    expect(await outcomes('gratitude_sweep', b.id)).toEqual(['skipped_suspended']);
    const listed = await db.listLiveBusinessesForJobs();
    expect(listed.find((x: any) => x.id === b.id)?.suspended_at).toBeTruthy();
    expect(listed.find((x: any) => x.id === other.id)?.suspended_at).toBeNull();
    const status = await jobs.jobsStatus(new Date(), { NODE_ENV: 'test', BILLING_ENFORCED: 'false' } as any);
    expect(status).toBeTruthy();
  });

  // ---- M7 / M8 / M10 -------------------------------------------------------------------------------------------------------------------------

  test('M7: tenant overrides of the caps and of the per-account business limit are ENFORCED; the *_cap_override column wins over them, then the plan, then the platform', async () => {
    const usage = await import('@/lib/db/usage');
    const { setTenantOverride, removeTenantOverride } = await import('@/lib/admin/tenant-overrides');
    const { createBusinessForOwner } = await import('@/lib/db/locations');
    setEnv('BILLING_ENFORCED', 'true');
    const actor: any = { kind: 'user', user_id: null, scope: 'platform', role: 'owner' };
    const set = (id: string, key: string, value: number) => setTenantOverride({ business_id: id, key, value, actor });
    const b = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: b.id }, data: { billingStatus: 'active' } });
    // SMS: platform default 500; a tenant override of 3 is the cap
    await set(b.id, 'billing.plan_sms_cap', 3);
    expect(await usage.reserveSms(b.id, 3)).toMatchObject({ ok: true, cap: 3 });
    expect(await usage.reserveSms(b.id, 1)).toMatchObject({ ok: false, reason: 'cap_reached', cap: 3 });
    // the column override is the more specific admin action and wins
    await prisma.business.update({ where: { id: b.id }, data: { smsCapOverride: 10 } });
    expect(await usage.reserveSms(b.id, 1)).toMatchObject({ ok: true, cap: 10 });
    await prisma.business.update({ where: { id: b.id }, data: { smsCapOverride: null } });
    await removeTenantOverride({ business_id: b.id, key: 'billing.plan_sms_cap', actor });
    expect((await usage.checkSmsAllowed(b.id)).cap).toBe(500); // back to the platform value
    // AI minutes, forwarded minutes and voicemail minutes
    await set(b.id, 'billing.plan_call_minutes_cap', 1); await set(b.id, 'forward.minutes_cap', 2); await set(b.id, 'voicemail.minutes_cap', 3);
    expect((await usage.checkCallAllowed(b.id)).cap).toBe(60);
    expect((await usage.checkForwardAllowed(b.id)).cap).toBe(120);
    expect((await usage.checkVoicemailAllowed(b.id)).cap).toBe(180);
    await usage.recordCallSeconds(b.id, 60);
    expect(await usage.checkCallAllowed(b.id)).toMatchObject({ ok: false, reason: 'cap_reached' });
    // the account's business limit: strictest effective value among the businesses it owns
    const user = await users.createUser({ email: `${uniq('own')}@review-fix.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: b.id, email_verified: true });
    userIds.push(user.id);
    await set(b.id, 'limits.max_businesses_per_user', 1);
    expect(await createBusinessForOwner(user.id, { name: 'Second location' })).toEqual({ ok: false, reason: 'limit_reached' });
    await set(b.id, 'limits.max_businesses_per_user', 5);
    const more = await createBusinessForOwner(user.id, { name: 'Second location' });
    expect(more.ok).toBe(true);
    if (more.ok) createdBusinesses.push(more.business.id);
  });

  test('M8: an owner can switch a platform-ON feature off but never switch on what the platform turned off', async () => {
    const { setTenantOverride } = await import('@/lib/admin/tenant-overrides');
    const { knobFrom, knobOr, loadTenantOverrides } = await import('@/lib/admin/tenant-knobs');
    const { ConfigSnapshot, setSnapshotSource } = await import('@/lib/config');
    const b = await newBusiness({ agent_id: null });
    const owner: any = { kind: 'user', user_id: null, scope: 'owner' };
    setSnapshotSource(() => new ConfigSnapshot({ version: 1, values: { 'jobs.briefing_enabled': false } }));
    try {
      const err = await setTenantOverride({ business_id: b.id, key: 'jobs.briefing_enabled', value: true, actor: owner }).catch((e) => e);
      expect([err.status, err.code]).toEqual([422, 'not_stricter']);
      expect(knobFrom<boolean>('jobs.briefing_enabled', await loadTenantOverrides(b.id))).toBe(false);
      // a stale `true` already in the table (set while the platform had it on) is ignored at read time
      await prisma.tenantSettingOverride.create({ data: { businessId: b.id, key: 'jobs.briefing_enabled', value: true } });
      expect(knobFrom<boolean>('jobs.briefing_enabled', await loadTenantOverrides(b.id))).toBe(false);
      expect(await knobOr(b.id, 'jobs.briefing_enabled', false)).toBe(false);
    } finally { setSnapshotSource(null); }
    expect((await setTenantOverride({ business_id: b.id, key: 'jobs.briefing_enabled', value: false, actor: owner })).value).toBe(false);
  });

  test('M10: a plan without `voicemail` / `call_forwarding` really switches them off (allowances refuse, a forward-mode business routes to the AI)', async () => {
    const { setPlanCatalog } = await import('@/lib/admin/plan-catalog');
    const { forwardAllowance, voicemailAllowance } = await import('@/lib/voice/forward-metering');
    const { resolveCallRoute } = await import('@/lib/voice/call-mode');
    const key = uniq('nofeat'); planKeys.push(key);
    const b = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: b.id }, data: { plan: key, billingStatus: 'active' } }); // the trigger registers the plan
    const row = (features: Record<string, boolean>) => ({ key, name: key, public: false, is_comped: false, stripe_price_id: null, stripe_price_id_annual: null, trial_days: null, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null, forward_minutes_cap: null, max_locations: null, features, sort: 1, archived_at: null });
    try {
      setPlanCatalog([row({})]);
      expect((await voicemailAllowance(b.id)).ok).toBe(true);
      expect((await forwardAllowance(b.id)).ok).toBe(true);
      setPlanCatalog([row({ voicemail: false, call_forwarding: false })]);
      expect(await voicemailAllowance(b.id)).toEqual({ ok: false, why: 'no_plan' });
      expect(await forwardAllowance(b.id)).toEqual({ ok: false, why: 'no_plan' });
      const full = await db.getBusiness(b.id);
      const route = resolveCallRoute({ ...full!, call_mode: 'forward', forward_number_e164: '+13055550123', forward_number_verified_at: new Date().toISOString(), owner_phone_e164: '+13055550123', owner_phone_verified_at: new Date().toISOString(), forward_during_hours: false } as any, new Date(), 'webhook');
      expect(route).toEqual({ action: 'ai', why: 'forward_not_in_plan' });
    } finally { setPlanCatalog(null); }
  });
});
