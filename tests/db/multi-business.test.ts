/**
 * Multi-business accounts: a user in A and B, active-business resolution, per-business roles, tenant isolation across routes, switching,
 * team changes with last-owner protection under concurrency, invitations into existing accounts, "Add another location".
 * Needs a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ADMIN_TOKEN, PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;
const LIMITER = ['auth/signup', 'auth/login', 'auth/switch-business', 'businesses/mine', 'team/invite', 'auth/accept-invite', 'auth/mfa'];

suite('multi-business accounts (postgres)', () => {
  let db: any, s: any, pw: any, mail: ReturnType<typeof captureMail>;
  const m: Record<string, any> = {};
  const run = rid();
  const email = (n: string) => `${n}-${run}@example.test`.toLowerCase();
  const A = `biz_ma_${run}`;
  const B = `biz_mb_${run}`;
  const C = `biz_mc_${run}`;
  const ids: Record<string, string> = {};
  const extraBiz: string[] = [];
  const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };

  beforeAll(async () => {
    ({ db, s, pw } = await loadAuthModules());
    for (const [k, p] of Object.entries({
      login: 'auth/login', sw: 'auth/switch-business', mine: 'businesses/mine', accept: 'auth/accept-invite', me: 'auth/me', logout: 'auth/logout',
      calls: 'calls', bookings: 'bookings', briefings: 'briefings', billing: 'billing/status', bizGet: 'businesses/[id]', settings: 'businesses/[id]/settings',
      onboarding: 'businesses/[id]/onboarding-status', bizList: 'businesses', team: 'team', audit: 'team/audit', invite: 'team/invite',
      userRoute: 'team/users/[id]', revoke: 'team/users/[id]/revoke-sessions', signup: 'auth/signup',
    })) m[k] = await import(`../../src/app/api/${p}/route`);
    mail = captureMail();
    for (const id of [A, B, C]) await db.prisma.business.create({ data: { id, name: `Biz ${id}`, status: 'live' } });
    await db.prisma.business.update({ where: { id: B }, data: { billingStatus: 'active' } });
    const hash = await pw.hashPassword(PASSWORD);
    const mk = async (n: string, role: 'owner' | 'staff' | 'admin', biz: string | null, verified = true) => {
      ids[n] = (await db.createUser({ email: email(n), password_hash: hash, role, business_id: biz, email_verified: verified })).id;
    };
    await mk('multi', 'owner', A);            // owner in A (primary) ...
    await db.addMembership({ user_id: ids.multi, business_id: B, role: 'staff' }); // ... staff in B
    await mk('ownerA', 'owner', A);
    await mk('ownerB', 'owner', B);
    await mk('staffA', 'staff', A);
    await mk('solo', 'staff', C);
    await mk('unver', 'owner', C, false);
    await mk('root', 'admin', null);
    await clearLimiter(db, LIMITER);
  });
  afterAll(async () => {
    mail.restore();
    const all = [A, B, C, ...extraBiz];
    await db.prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: { in: all } }, { actorUserId: { in: Object.values(ids) } }] } });
    await db.prisma.user.deleteMany({ where: { OR: [{ id: { in: Object.values(ids) } }, { email: { endsWith: `-${run}@example.test` } }] } });
    await db.prisma.business.deleteMany({ where: { id: { in: all } } });
    await clearLimiter(db, [...LIMITER, 'auth/reauth']);
    await db.prisma.$disconnect();
  });

  async function signIn(n: string): Promise<string> {
    await clearLimiter(db, ['auth/login']);
    const res = await m.login.POST(req('/api/auth/login', { method: 'POST', json: { email: email(n), password: PASSWORD } }));
    expect(res.status).toBe(200);
    return cookieFrom(res) as string;
  }
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (mod: any, path: string, cookie: string, c?: any) => (c ? mod.GET(req(path, { headers: { cookie } }), c) : mod.GET(req(path, { headers: { cookie } })));
  const post = (mod: any, path: string, cookie: string | null, json: unknown = {}, headers: Record<string, string> = {}) =>
    mod.POST(req(path, { method: 'POST', json, headers: { ...(cookie ? { cookie } : {}), ...headers } }));
  const switchTo = (cookie: string, business_id: string) => post(m.sw, '/api/auth/switch-business', cookie, { business_id });
  const meOf = async (cookie: string) => (await (await get(m.me, '/api/auth/me', cookie)).json()).data;
  const activeOf = (cookie: string) => db.prisma.userSession.findFirst({ where: { tokenHash: db.hashSessionToken(cookie.split('=')[1]) } });

  // Every business-scoped GET, parameterised by business id: [name, call, minimum role of the caller in that business]
  const matrix: [string, (c: string, id: string) => Promise<Response>, 'staff' | 'owner'][] = [
    ['GET /api/calls', (c, id) => get(m.calls, `/api/calls?business_id=${id}`, c), 'staff'],
    ['GET /api/bookings', (c, id) => get(m.bookings, `/api/bookings?business_id=${id}`, c), 'staff'],
    ['GET /api/briefings', (c, id) => get(m.briefings, `/api/briefings?business_id=${id}`, c), 'staff'],
    ['GET /api/billing/status', (c, id) => get(m.billing, `/api/billing/status?business_id=${id}`, c), 'staff'],
    ['GET /api/businesses/:id', (c, id) => get(m.bizGet, `/api/businesses/${id}`, c, ctx(id)), 'staff'],
    ['GET /api/businesses/:id/settings', (c, id) => get(m.settings, `/api/businesses/${id}/settings`, c, ctx(id)), 'staff'],
    ['GET /api/businesses/:id/onboarding-status', (c, id) => get(m.onboarding, `/api/businesses/${id}/onboarding-status`, c, ctx(id)), 'owner'],
    ['GET /api/team', (c, id) => get(m.team, `/api/team?business_id=${id}`, c), 'owner'],
    ['GET /api/team/audit', (c, id) => get(m.audit, `/api/team/audit?business_id=${id}`, c), 'owner'],
  ];

  test('the principal: active business and the role come from the MEMBERSHIP (owner in A, staff in B)', async () => {
    const cookie = await signIn('multi');
    let me = await meOf(cookie);
    expect(me).toMatchObject({ role: 'owner', business_id: A });
    expect(me.memberships.map((x: any) => `${x.business_id}:${x.role}`).sort()).toEqual([`${A}:owner`, `${B}:staff`].sort());
    expect((await switchTo(cookie, B)).status).toBe(200);
    me = await meOf(cookie);
    expect(me).toMatchObject({ role: 'staff', business_id: B });
    // the legacy users.role is still 'owner' (primary business A): it must not leak into B
    expect((await db.getUserById(ids.multi)).role).toBe('owner');
    const r = await s.resolvePrincipal(new Headers({ cookie }));
    expect(r.principal).toMatchObject({ kind: 'user', business_id: B, role: 'staff' });
  });

  test('isolation matrix: active A cannot touch B until switched; staff-vs-owner per business; every cross-tenant answer is 404', async () => {
    const cookie = await signIn('multi');
    // active A (owner): own business works, B is 404 on EVERY route even though the account belongs to it
    for (const [name, call] of matrix) {
      expect([name, (await call(cookie, A)).status]).toEqual([name, 200]);
      expect([name, (await call(cookie, B)).status]).toEqual([name, 404]);
    }
    expect((await switchTo(cookie, B)).status).toBe(200);
    for (const [name, call, min] of matrix) {
      expect([name, (await call(cookie, A)).status]).toEqual([name, min === 'owner' ? 403 : 404]); // A is now the foreign one (owner-only routes refuse the staff role first: still nothing about A leaks)
      const own = (await call(cookie, B)).status;
      expect([name, own]).toEqual([name, min === 'owner' ? 403 : 200]); // staff in B: owner-only routes are 403, the rest work
    }
    // without a business_id the routes default to the ACTIVE business
    const calls = await (await get(m.calls, '/api/calls', cookie)).json();
    expect(calls.ok).toBe(true);
    expect((await (await get(m.billing, '/api/billing/status', cookie)).json()).data.billing_status ?? (await (await get(m.billing, '/api/billing/status', cookie)).json()).data.status).toBeDefined();
    // switching back restores the owner role in A
    expect((await switchTo(cookie, A)).status).toBe(200);
    expect((await matrix[7][1](cookie, A)).status).toBe(200);
    // a business the account has no membership in at all: 404 everywhere (same answer as a nonexistent id)
    for (const [name, call] of matrix) expect([name, (await call(cookie, C)).status]).toEqual([name, 404]);
    for (const [name, call] of matrix) expect([name, (await call(cookie, 'does-not-exist')).status]).toEqual([name, 404]);
    // billing is per business: B is 'active', A is not
    await switchTo(cookie, A);
    const billA = (await (await get(m.billing, '/api/billing/status', cookie)).json()).data;
    await switchTo(cookie, B);
    const billB = (await (await get(m.billing, '/api/billing/status', cookie)).json()).data;
    expect(JSON.stringify(billA)).not.toEqual(JSON.stringify(billB));
    // the businesses list shows the memberships (not C)
    const list = (await (await get(m.bizList, '/api/businesses', cookie)).json()).data;
    expect(list.map((b: any) => b.id).sort()).toEqual([A, B].sort());
    // an admin still sees every business and names the one it wants
    const adm = await m.team.GET(req(`/api/team?business_id=${C}`, { headers: ADMIN }));
    expect(adm.status).toBe(200);
  });

  test('switch-business: membership checked atomically, CSRF, only this session changes, audited, unauthenticated/admin refused', async () => {
    const c1 = await signIn('multi');
    const c2 = await signIn('multi');
    expect((await switchTo(c1, C)).status).toBe(404);             // not a member
    expect((await switchTo(c1, 'nope')).status).toBe(404);        // nonexistent: same answer
    expect((await activeOf(c1)).activeBusinessId).toBeNull();
    expect((await post(m.sw, '/api/auth/switch-business', c1, {})).status).toBe(422);
    const noCsrf = await m.sw.POST(new Request('http://app.test/api/auth/switch-business', { method: 'POST', headers: { cookie: c1, 'content-type': 'application/json' }, body: JSON.stringify({ business_id: B }) }));
    expect(noCsrf.status).toBe(403);
    const cross = await m.sw.POST(req('/api/auth/switch-business', { method: 'POST', json: { business_id: B }, headers: { cookie: c1, 'sec-fetch-site': 'cross-site' } }));
    expect(cross.status).toBe(403);
    expect((await activeOf(c1)).activeBusinessId).toBeNull();
    expect((await post(m.sw, '/api/auth/switch-business', null, { business_id: B })).status).toBe(401);
    expect((await m.sw.POST(req('/api/auth/switch-business', { method: 'POST', json: { business_id: B }, headers: ADMIN }))).status).toBe(403);
    const ok = await switchTo(c1, B);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, data: { business_id: B, role: 'staff' } });
    expect((await activeOf(c1)).activeBusinessId).toBe(B);
    expect((await activeOf(c2)).activeBusinessId).toBeNull();        // the other device is untouched
    expect((await meOf(c2)).business_id).toBe(A);
    // the session token is unchanged by a switch (identity did not change); a login replaces a planted/previous session (no fixation)
    const login2 = await m.login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('multi'), password: PASSWORD }, headers: { cookie: c1 } }));
    expect(login2.status).toBe(200);
    expect(await db.resolveSessionByToken(c1.split('=')[1])).toBeNull();
    const fresh = cookieFrom(login2) as string;
    expect((await activeOf(fresh)).activeBusinessId).toBeNull();     // a new session never inherits the old session's active business
    const audit = await db.listAuditEvents({ actor_user_id: ids.multi, action: 'auth.business_switched' });
    expect(audit.some((a: any) => a.business_id === B && a.meta.to === B)).toBe(true);
    // a mutation in the other business after switching: the owner-only invite route is 403 as staff in B
    expect((await post(m.invite, '/api/team/invite', c1.length ? fresh : fresh, { email: email('x1'), role: 'staff' })).status).toBe(201); // fresh session: active A, owner
    await switchTo(fresh, B);
    expect((await post(m.invite, '/api/team/invite', fresh, { email: email('x2'), role: 'staff' })).status).toBe(403);
  });

  test('disabled membership: the session falls back, switching to it is 404, the account and its other business keep working', async () => {
    const cookie = await signIn('multi');
    await switchTo(cookie, B);
    const ownerB = await signIn('ownerB');
    const off = await m.userRoute.PATCH(req(`/api/team/users/${ids.multi}`, { method: 'PATCH', json: { disabled: true }, headers: { cookie: ownerB } }), ctx(ids.multi));
    expect(off.status).toBe(200);
    expect((await activeOf(cookie)).activeBusinessId).toBeNull();
    expect(await meOf(cookie)).toMatchObject({ business_id: A, role: 'owner' });
    expect((await switchTo(cookie, B)).status).toBe(404);
    expect((await matrix[4][1](cookie, B)).status).toBe(404);
    expect((await db.getUserById(ids.multi)).disabled_at).toBeNull();
    // ownerB's team list shows the member as disabled, not gone
    const list = (await (await get(m.team, '/api/team', ownerB)).json()).data.users;
    expect(list.find((u: any) => u.id === ids.multi).disabled_at).not.toBeNull();
    const on = await m.userRoute.PATCH(req(`/api/team/users/${ids.multi}`, { method: 'PATCH', json: { disabled: false }, headers: { cookie: ownerB } }), ctx(ids.multi));
    expect(on.status).toBe(200);
    // residual L5: re-enabling the membership does NOT revive a session that already lost B; a new sign-in does
    expect((await switchTo(cookie, B)).status).toBe(404);
    const fresh = await signIn('multi');
    expect((await switchTo(fresh, B)).status).toBe(200);
    // an account disabled in its ONLY business cannot sign in at all (and says nothing about why)
    await db.disableMembership(ids.solo, C);
    await clearLimiter(db, ['auth/login']);
    expect((await m.login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('solo'), password: PASSWORD } }))).status).toBe(401);
    await db.enableMembership(ids.solo, C);
  });

  test('team management is per business: roles, removal keeps the account, owners cannot reach other businesses members', async () => {
    const ownerA = await signIn('ownerA');
    // roles are per business: changing multi's role in A does not touch B
    const demote = await m.userRoute.PATCH(req(`/api/team/users/${ids.multi}`, { method: 'PATCH', json: { role: 'staff' }, headers: { cookie: ownerA } }), ctx(ids.multi));
    expect(demote.status).toBe(200);
    expect((await db.getMembership(ids.multi, A)).role).toBe('staff');
    expect((await db.getMembership(ids.multi, B)).role).toBe('staff');
    await db.setMembershipRole(ids.multi, A, 'owner');
    // an owner of A cannot see or change someone who is only in B
    expect((await m.userRoute.PATCH(req(`/api/team/users/${ids.ownerB}`, { method: 'PATCH', json: { role: 'staff' }, headers: { cookie: ownerA } }), ctx(ids.ownerB))).status).toBe(404);
    expect((await m.userRoute.DELETE(req(`/api/team/users/${ids.ownerB}`, { method: 'DELETE', headers: { cookie: ownerA } }), ctx(ids.ownerB))).status).toBe(404);
    expect((await m.revoke.POST(req(`/api/team/users/${ids.ownerB}/revoke-sessions`, { method: 'POST', headers: { cookie: ownerA } }), ctx(ids.ownerB))).status).toBe(404);
    // an admin acting on a user of several businesses must name one
    expect((await m.userRoute.PATCH(req(`/api/team/users/${ids.multi}`, { method: 'PATCH', json: { role: 'staff' }, headers: ADMIN }), ctx(ids.multi))).status).toBe(422);
    // removing multi from B keeps the account and its membership in A; the session that worked in B falls back
    const cookie = await signIn('multi');
    await switchTo(cookie, B);
    const ownerB = await signIn('ownerB');
    const rm = await m.userRoute.DELETE(req(`/api/team/users/${ids.multi}`, { method: 'DELETE', headers: { cookie: ownerB } }), ctx(ids.multi));
    expect(rm.status).toBe(200);
    expect(await db.getMembership(ids.multi, B)).toBeNull();
    expect((await db.getMembership(ids.multi, A)).disabled_at).toBeNull();
    expect(await db.getUserById(ids.multi)).not.toBeNull();
    expect(await meOf(cookie)).toMatchObject({ business_id: A, role: 'owner' });
    // removing a user's LAST membership deletes the account (as removing a team member always did)
    await db.addMembership({ user_id: ids.multi, business_id: B, role: 'staff' });
    const gone = await db.createUser({ email: email('temp'), password_hash: 'x'.repeat(30), role: 'staff', business_id: B });
    const rm2 = await m.userRoute.DELETE(req(`/api/team/users/${gone.id}`, { method: 'DELETE', headers: { cookie: ownerB } }), ctx(gone.id));
    expect(rm2.status).toBe(200);
    expect(await db.getUserById(gone.id)).toBeNull();
    // removing the legacy PRIMARY business of a multi-business account re-points it to a remaining one
    const prim = await db.createUser({ email: email('prim'), password_hash: 'x'.repeat(30), role: 'owner', business_id: C });
    ids.prim = prim.id;
    await db.addMembership({ user_id: prim.id, business_id: A, role: 'staff' });
    await db.prisma.membership.updateMany({ where: { userId: prim.id, businessId: C }, data: {} });
    const cOwner = await db.createUser({ email: email('cowner'), password_hash: 'x'.repeat(30), role: 'owner', business_id: C });
    ids.cowner = cOwner.id;
    expect((await db.removeMembership(prim.id, C)).ok).toBe(true);
    const u = await db.prisma.user.findUnique({ where: { id: prim.id } });
    expect(u.businessId).toBe(A);
    expect(u.role).toBe('staff');
  });

  test('last-owner protection holds under concurrency (demote / disable / remove races)', async () => {
    const D = `biz_md_${run}`;
    extraBiz.push(D);
    await db.prisma.business.create({ data: { id: D, name: 'Race', status: 'live' } });
    const hash = 'x'.repeat(30);
    const o1 = await db.createUser({ email: email('race1'), password_hash: hash, role: 'owner', business_id: D });
    const o2 = await db.createUser({ email: email('race2'), password_hash: hash, role: 'owner', business_id: D });
    ids.race1 = o1.id; ids.race2 = o2.id;
    const owners = () => db.countActiveOwners(D);
    // two owners demote EACH OTHER at the same time: exactly one succeeds
    const rs = await Promise.all([db.setMembershipRole(o1.id, D, 'staff'), db.setMembershipRole(o2.id, D, 'staff')]);
    expect(rs.filter((r: any) => r.ok).length).toBe(1);
    expect(rs.filter((r: any) => !r.ok && r.reason === 'last_owner').length).toBe(1);
    expect(await owners()).toBe(1);
    const survivor = rs[0].ok ? o2.id : o1.id;
    const other = survivor === o1.id ? o2.id : o1.id;
    // restore both, then mix disable + demote + remove in parallel, many rounds
    for (let i = 0; i < 6; i++) {
      await db.setMembershipRole(other, D, 'owner');
      await db.disableMembership(other, D, false);
      await db.setMembershipRole(survivor, D, 'owner');
      await db.disableMembership(survivor, D, false);
      expect(await owners()).toBe(2);
      const results = await Promise.all([
        db.disableMembership(o1.id, D), db.setMembershipRole(o2.id, D, 'staff'), db.disableMembership(o2.id, D), db.setMembershipRole(o1.id, D, 'staff'),
        db.removeMembership(o1.id, D).then((r: any) => (r.ok ? { ok: true } : r)),
      ]);
      expect(await owners()).toBeGreaterThanOrEqual(1);
      expect(results.some((r: any) => !r.ok && r.reason === 'last_owner')).toBe(true);
      if (!(await db.getUserById(o1.id))) { // the remove won: put the account back (its only membership went with it)
        ids.race1 = o1.id = (await db.createUser({ email: email(`race1-${i}`), password_hash: hash, role: 'owner', business_id: D })).id;
      }
    }
    // the HTTP layer reports it: 409 last_owner
    const lone = await db.createUser({ email: email('lone'), password_hash: await pw.hashPassword(PASSWORD), role: 'owner', business_id: `${D}` });
    ids.lone = lone.id;
    await db.prisma.membership.updateMany({ where: { businessId: D, userId: { not: lone.id } }, data: { disabledAt: new Date() } });
    const cookie = await signIn('lone');
    const r = await m.userRoute.PATCH(req(`/api/team/users/${lone.id}`, { method: 'PATCH', json: { role: 'staff' }, headers: { cookie } }), ctx(lone.id));
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('last_owner');
    expect(await owners()).toBeGreaterThanOrEqual(1);
  });

  test('invite an EXISTING account into another business: bound to business+role+email, one click when signed in, sign-in first otherwise', async () => {
    const ownerB = await signIn('ownerB');
    const invited = email('solo'); // an account whose only business is C
    const res = await post(m.invite, '/api/team/invite', ownerB, { email: invited, role: 'owner' });
    expect(res.status).toBe(201);                                   // no more ACCOUNT_EXISTS refusal
    const mailOf = mail.to(invited).at(-1)!;
    const peek = await db.peekEmailToken('invite', mailOf.token);
    expect(peek).toMatchObject({ business_id: B, role: 'owner', email: invited });
    expect(peek.user_id).toBe(ids.solo);
    // logged out: asked to sign in; nothing consumed
    const out = await post(m.accept, '/api/auth/accept-invite', null, { token: mailOf.token });
    expect(out.status).toBe(401);
    expect((await out.json()).code).toBe('login_required');
    // the WRONG account (another address) cannot use someone else's link
    const wrong = await post(m.accept, '/api/auth/accept-invite', await signIn('ownerA'), { token: mailOf.token });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).code).toBe('wrong_account');
    expect(await db.peekEmailToken('invite', mailOf.token)).not.toBeNull();
    expect(await db.getMembership(ids.solo, B)).toBeNull();
    // a password in the body does not let an anonymous caller take over the existing account's invite
    expect((await post(m.accept, '/api/auth/accept-invite', null, { token: mailOf.token, password: 'a-totally-new-pass-123' })).status).toBe(401);
    expect(await db.getMembership(ids.solo, B)).toBeNull();
    // the right account accepts with one click: membership with the INVITED role, session moves to the new business, audited
    const solo = await signIn('solo');
    const ok = await post(m.accept, '/api/auth/accept-invite', solo, { token: mailOf.token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, data: { accepted: true, existing_account: true, role: 'owner', business_id: B } });
    expect((await db.getMembership(ids.solo, B)).role).toBe('owner');
    expect((await db.getMembership(ids.solo, C)).role).toBe('staff'); // the other business is untouched
    expect(await meOf(solo)).toMatchObject({ business_id: B, role: 'owner' });
    expect((await db.getUserById(ids.solo)).business_id).toBe(C);    // the primary business does not change
    const acts = (await db.listAuditEvents({ business_id: B })).map((a: any) => a.action);
    expect(acts).toContain('user.invite_accepted');
    // replay: burned
    expect((await post(m.accept, '/api/auth/accept-invite', solo, { token: mailOf.token })).status).toBe(400);
    // already a member: a new invite is refused up front
    expect((await post(m.invite, '/api/team/invite', ownerB, { email: invited, role: 'staff' })).status).toBe(409);
  });

  test('invite acceptance: expired and revoked links, already-member with a stale link, unverified account gets verified by the link', async () => {
    const ownerA = await signIn('ownerA');
    const target = email('unver'); // owner of C, email NOT verified
    expect((await post(m.invite, '/api/team/invite', ownerA, { email: target, role: 'staff' })).status).toBe(201);
    const t = mail.to(target).at(-1)!;
    const cookie = await signIn('unver');
    // expired
    await db.prisma.emailToken.updateMany({ where: { tokenHash: db.hashEmailToken(t.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post(m.accept, '/api/auth/accept-invite', cookie, { token: t.token })).status).toBe(400);
    // fresh, then revoked by the inviter
    expect((await post(m.invite, '/api/team/invite', ownerA, { email: target, role: 'staff' })).status).toBe(201);
    const t2 = mail.to(target).at(-1)!;
    const invs = (await (await get(m.team, '/api/team', ownerA)).json()).data.invites.filter((i: any) => i.email === target);
    expect(invs.length).toBe(1);
    await db.prisma.emailToken.updateMany({ where: { id: invs[0].id }, data: { usedAt: new Date() } });
    expect((await post(m.accept, '/api/auth/accept-invite', cookie, { token: t2.token })).status).toBe(400);
    // fresh again and accepted: the mailbox is proven by the link
    expect((await post(m.invite, '/api/team/invite', ownerA, { email: target, role: 'staff' })).status).toBe(201);
    const t3 = mail.to(target).at(-1)!;
    expect((await post(m.accept, '/api/auth/accept-invite', cookie, { token: t3.token })).status).toBe(200);
    expect((await db.getUserById(ids.unver)).email_verified_at).not.toBeNull();
    expect((await db.getMembership(ids.unver, A)).role).toBe('staff');
    // a stale second link for a business the person is already in is refused WITHOUT consuming it (and never changes their role)
    const stale = await db.createEmailToken({ purpose: 'invite', email: target, business_id: A, role: 'owner', invited_by: ids.ownerA });
    const again = await post(m.accept, '/api/auth/accept-invite', cookie, { token: stale.token });
    expect(again.status).toBe(409);
    expect((await db.getMembership(ids.unver, A)).role).toBe('staff');
    expect(await db.peekEmailToken('invite', stale.token)).not.toBeNull();
  });

  test('signup with an existing address stays non-enumerating (same answer, no new business, no account touched)', async () => {
    await clearLimiter(db, ['auth/signup']);
    const known = await post(m.signup, '/api/auth/signup', null, { email: email('multi'), password: PASSWORD, business_name: `Dup Biz ${run}` });
    const unknown = await post(m.signup, '/api/auth/signup', null, { email: email('brand-new'), password: PASSWORD, business_name: `New Biz ${run}` });
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    expect(await db.prisma.business.count({ where: { name: `Dup Biz ${run}` } })).toBe(0); // the existing address made no business
    expect(await db.prisma.business.count({ where: { name: `New Biz ${run}` } })).toBe(1);
    extraBiz.push(...(await db.prisma.business.findMany({ where: { name: `New Biz ${run}` }, select: { id: true } })).map((b: any) => b.id));
  });

  test('Add another location: owners only, verified email, per-user cap (also under concurrency), per-business billing, atomic', async () => {
    process.env.MAX_BUSINESSES_PER_USER = '3';
    try {
      await clearLimiter(db, ['businesses/mine']);
      // staff-only account: refused
      expect((await post(m.mine, '/api/businesses/mine', await signIn('staffA'), { name: 'Nope' })).status).toBe(403);
      // owner with an UNVERIFIED email: refused
      await db.createUser({ email: email('unver2'), password_hash: await pw.hashPassword(PASSWORD), role: 'owner', business_id: C, email_verified: false });
      const un = await post(m.mine, '/api/businesses/mine', await signIn('unver2'), { name: 'Nope' });
      expect(un.status).toBe(403);
      expect((await un.json()).code).toBe('email_not_verified');
      // anonymous / admin / bad name
      expect((await post(m.mine, '/api/businesses/mine', null, { name: 'Nope' })).status).toBe(401);
      expect((await m.mine.POST(req('/api/businesses/mine', { method: 'POST', json: { name: 'Nope' }, headers: ADMIN }))).status).toBe(403);
      const cookie = await signIn('ownerA');
      expect((await post(m.mine, '/api/businesses/mine', cookie, { name: 'x' })).status).toBe(422);
      expect((await post(m.mine, '/api/businesses/mine', cookie, { name: '<b>' })).status).toBe(422);
      const noCsrf = await m.mine.POST(new Request('http://app.test/api/businesses/mine', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nope' }) }));
      expect(noCsrf.status).toBe(403);
      // ownerA owns 1 (A): two more allowed with the cap at 3
      const one = await post(m.mine, '/api/businesses/mine', cookie, { name: 'Second Location' });
      expect(one.status).toBe(201);
      const created = (await one.json()).data.business;
      extraBiz.push(created.id);
      const row = await db.getBusiness(created.id);
      expect(row.billing_status).toBe('none');                        // billing starts at 'none' for each business
      expect(row.phone).toBeNull();                                    // nothing provisioned
      expect(await db.getMembership(ids.ownerA, created.id)).toMatchObject({ role: 'owner', disabled_at: null });
      expect((await db.getUserById(ids.ownerA)).business_id).toBe(A); // primary unchanged
      expect(await meOf(cookie)).toMatchObject({ business_id: created.id, role: 'owner' }); // the session moved to the new business
      expect((await (await get(m.team, '/api/team', cookie)).json()).data.users.map((u: any) => u.id)).toEqual([ids.ownerA]); // its team is just the creator
      expect((await db.listAuditEvents({ business_id: created.id })).map((a: any) => a.action)).toContain('business.created_additional');
      // concurrency: 5 parallel requests with room for exactly one more
      await clearLimiter(db, ['businesses/mine']);
      const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => post(m.mine, '/api/businesses/mine', cookie, { name: `Race ${i}` })));
      const ok = rs.filter((r) => r.status === 201);
      expect(ok.length).toBe(1);
      for (const r of rs) if (r.status !== 201) { expect([409, 429]).toContain(r.status); }
      for (const r of ok) extraBiz.push((await r.json()).data.business.id);
      expect(await db.prisma.membership.count({ where: { userId: ids.ownerA, role: 'owner' } })).toBe(3);
      // at the cap: a clear 409
      await clearLimiter(db, ['businesses/mine']);
      const capped = await post(m.mine, '/api/businesses/mine', cookie, { name: 'One too many' });
      expect(capped.status).toBe(409);
      expect((await capped.json()).code).toBe('limit_reached');
      expect(await db.prisma.business.count({ where: { name: 'One too many' } })).toBe(0);
      // rate limit: 5 attempts per hour per account
      process.env.MAX_BUSINESSES_PER_USER = '50';
      await clearLimiter(db, ['businesses/mine']);
      const seen: number[] = [];
      for (let i = 0; i < 6; i++) { const r = await post(m.mine, '/api/businesses/mine', cookie, { name: `Rate ${i}` }); seen.push(r.status); if (r.status === 201) extraBiz.push((await r.json()).data.business.id); }
      expect(seen.slice(0, 5).every((x) => x === 201)).toBe(true);
      expect(seen[5]).toBe(429);
    } finally {
      delete process.env.MAX_BUSINESSES_PER_USER;
    }
  });

  test('a business created later is isolated: another account cannot reach it, and deleting a business keeps people who belong elsewhere', async () => {
    await clearLimiter(db, ['businesses/mine']);
    const owner = await signIn('ownerA');
    const created = (await (await post(m.mine, '/api/businesses/mine', owner, { name: 'Isolated' })).json()).data.business;
    extraBiz.push(created.id);
    const other = await signIn('ownerB');
    for (const [name, call] of matrix) expect([name, (await call(other, created.id)).status]).toEqual([name, 404]);
    // deleting a business must not delete an account that also belongs to another one
    await db.addMembership({ user_id: ids.ownerB, business_id: created.id, role: 'staff' });
    await db.prisma.business.delete({ where: { id: created.id } });
    expect(await db.getUserById(ids.ownerB)).not.toBeNull();
    expect((await db.getMembership(ids.ownerB, B)).role).toBe('owner');
  });

  test('R14 L2: an owner signs a shared member out of THIS business only; a platform admin signs the account out everywhere', async () => {
    const inA = await signIn('multi');          // primary business A (active business unset)
    const inB = await signIn('multi');
    expect((await switchTo(inB, B)).status).toBe(200);
    const ownerA = await signIn('ownerA');
    const r = await m.revoke.POST(req(`/api/team/users/${ids.multi}/revoke-sessions`, { method: 'POST', headers: { cookie: ownerA } }), ctx(ids.multi));
    expect(r.status).toBe(200);
    expect(await activeOf(inA)).toBeNull();                                   // the session working in A is gone
    expect((await get(m.me, '/api/auth/me', inB)).status).toBe(200);          // the one working in B (where A's owner has no authority) is untouched
    expect(await activeOf(inB)).not.toBeNull();
    // an admin acting on one business signs the whole account out
    const again = await signIn('multi');
    expect((await switchTo(again, B)).status).toBe(200);
    const adm = await m.revoke.POST(req(`/api/team/users/${ids.multi}/revoke-sessions?business_id=${A}`, { method: 'POST', headers: ADMIN }), ctx(ids.multi));
    expect(adm.status).toBe(200);
    expect(await activeOf(inB)).toBeNull();
    expect(await activeOf(again)).toBeNull();
  });
  test('residual L5: "sign out of this business" is real: the person\'s other sessions can no longer act in or switch back to it until they sign in again', async () => {
    const inA = await signIn('multi');
    const inB = await signIn('multi');
    expect((await switchTo(inB, B)).status).toBe(200);
    const ownerA = await signIn('ownerA');
    expect((await m.revoke.POST(req(`/api/team/users/${ids.multi}/revoke-sessions`, { method: 'POST', headers: { cookie: ownerA } }), ctx(ids.multi))).status).toBe(200);
    expect(await activeOf(inA)).toBeNull(); // the session working in A is gone
    const row = await activeOf(inB);
    expect(row.revokedBusinessIds).toEqual([A]); // the one in B survives, marked
    expect((await switchTo(inB, A)).status).toBe(404);
    expect(await meOf(inB)).toMatchObject({ business_id: B });
    expect((await matrix[4][1](inB, A)).status).toBe(404);
    // falling back to "the primary" must not land in A either
    await db.setSessionActiveBusiness(row.id, null);
    expect(await meOf(inB)).toMatchObject({ business_id: B });
    // the marker is idempotent (a second sign-out does not duplicate it) ...
    expect((await switchTo(inB, B)).status).toBe(200);
    await m.revoke.POST(req(`/api/team/users/${ids.multi}/revoke-sessions`, { method: 'POST', headers: { cookie: ownerA } }), ctx(ids.multi));
    expect((await activeOf(inB)).revokedBusinessIds).toEqual([A]);
    // ... and signing in again is the way back
    const again = await signIn('multi');
    expect((await switchTo(again, A)).status).toBe(200);
    expect((await activeOf(again)).revokedBusinessIds ?? []).toEqual([]);
    // an owner of ANOTHER business has no say over A: B's owner cannot sign the person out of A
    const ownerB = await signIn('ownerB');
    const foreign = await m.revoke.POST(req(`/api/team/users/${ids.multi}/revoke-sessions?business_id=${A}`, { method: 'POST', headers: { cookie: ownerB } }), ctx(ids.multi));
    expect([403, 404]).toContain(foreign.status);
    expect((await activeOf(again)).revokedBusinessIds ?? []).toEqual([]);
  });

  test('residual L5: a disabled or removed membership revokes the business for the account\'s other sessions; a fresh invitation lifts it only for the accepting session', async () => {
    const extra = `biz_mx_${run}`;
    extraBiz.push(extra);
    await db.prisma.business.create({ data: { id: extra, name: 'Extra', status: 'live' } });
    ids.visitor = (await db.createUser({ email: email('visitor'), password_hash: await pw.hashPassword(PASSWORD), role: 'staff', business_id: A, email_verified: true })).id;
    await db.addMembership({ user_id: ids.visitor, business_id: extra, role: 'staff' });
    const s1 = await signIn('visitor');
    expect((await switchTo(s1, extra)).status).toBe(200);
    expect((await switchTo(s1, A)).status).toBe(200);
    const s2 = await signIn('visitor'); // a second session, still on its primary (A)
    // the membership in `extra` is disabled and re-enabled: BOTH sessions lost it for good
    await db.disableMembership(ids.visitor, extra);
    await db.enableMembership(ids.visitor, extra);
    expect((await switchTo(s1, extra)).status).toBe(404);
    expect((await switchTo(s2, extra)).status).toBe(404);
    expect((await activeOf(s2)).revokedBusinessIds).toEqual([extra]);
    // a new sign-in works
    expect((await switchTo(await signIn('visitor'), extra)).status).toBe(200);
    // removal (the person keeps the account: they belong to A as well)
    expect((await db.removeMembership(ids.visitor, extra)).ok).toBe(true);
    // report 17 M3: invited again and accepted. Only the session that ACCEPTED lifts its own sign-out; the person's other sessions (a stolen
    // laptop that was signed out of this business) stay revoked until a new login.
    const accepting = await db.prisma.userSession.findFirst({ where: { userId: ids.visitor }, orderBy: { createdAt: 'desc' } }); // the sign-in made just above
    await db.prisma.userSession.update({ where: { id: accepting!.id }, data: { revokedBusinessIds: [extra] } });
    await db.addMembership({ user_id: ids.visitor, business_id: extra, role: 'staff', session_id: accepting!.id });
    expect((await db.prisma.userSession.findUnique({ where: { id: accepting!.id } }))!.revokedBusinessIds).toEqual([]); // the accepting session
    expect((await switchTo(s1, extra)).status).toBe(404); // the old sessions stay revoked: a fresh grant is not their consent
    expect((await switchTo(s2, extra)).status).toBe(404);
    expect((await activeOf(s1)).revokedBusinessIds).toContain(extra);
    // without a session (an admin-side grant) nothing is lifted anywhere
    await db.removeMembership(ids.visitor, extra);
    await db.addMembership({ user_id: ids.visitor, business_id: extra, role: 'staff' });
    expect((await activeOf(s1)).revokedBusinessIds).toContain(extra);
    await db.removeMembership(ids.visitor, extra);
    expect((await activeOf(s1)).revokedBusinessIds).toContain(extra);
  });
});
