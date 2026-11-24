/**
 * Team management: tenant isolation, role matrix, last-owner protection, CSRF, audit viewer
 * against a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ADMIN_TOKEN, PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;

suite('team management (postgres)', () => {
  let db: any, s: any, pw: any, mail: ReturnType<typeof captureMail>;
  let login: any, team: any, invite: any, inviteId: any, resendRoute: any, userRoute: any, revokeRoute: any, auditRoute: any;
  const run = rid();
  const email = (n: string) => `${n}-${run}@example.test`.toLowerCase();
  const A = `biz_ta_${run}`;
  const B = `biz_tb_${run}`;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };

  beforeAll(async () => {
    ({ db, s, pw } = await loadAuthModules());
    login = await import('../../src/app/api/auth/login/route');
    team = await import('../../src/app/api/team/route');
    invite = await import('../../src/app/api/team/invite/route');
    inviteId = await import('../../src/app/api/team/invites/[id]/route');
    resendRoute = await import('../../src/app/api/team/invites/[id]/resend/route');
    userRoute = await import('../../src/app/api/team/users/[id]/route');
    revokeRoute = await import('../../src/app/api/team/users/[id]/revoke-sessions/route');
    auditRoute = await import('../../src/app/api/team/audit/route');
    mail = captureMail();
    for (const id of [A, B]) await db.prisma.business.create({ data: { id, name: `Team ${id}`, status: 'live' } });
    const hash = await pw.hashPassword(PASSWORD);
    for (const [n, role, biz] of [['ownerA', 'owner', A], ['owner2A', 'owner', A], ['staffA', 'staff', A], ['ownerB', 'owner', B], ['staffB', 'staff', B]] as const) {
      ids[n] = (await db.createUser({ email: email(n), password_hash: hash, role, business_id: biz, email_verified: true })).id;
    }
    ids.root = (await db.createUser({ email: email('root'), password_hash: hash, role: 'admin', email_verified: true })).id;
    await clearLimiter(db, ['auth/login']);
    for (const n of ['ownerA', 'owner2A', 'staffA', 'ownerB', 'staffB', 'root']) {
      await clearLimiter(db, ['auth/login']);
      const res = await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email(n), password: PASSWORD } }));
      cookies[n] = cookieFrom(res) as string;
    }
  });
  afterAll(async () => {
    mail.restore();
    await db.prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: { in: [A, B] } }, { actorUserId: { in: Object.values(ids) } }] } });
    await db.prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await db.prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
    await clearLimiter(db, ['auth/login', 'team/invite']);
    await db.prisma.$disconnect();
  });

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const asUser = (n: string, extra: Record<string, string> = {}) => ({ headers: { cookie: cookies[n], ...extra } });
  const patch = (n: string, id: string, json: unknown, q = '') => userRoute.PATCH(req(`/api/team/users/${id}${q}`, { method: 'PATCH', json, ...asUser(n) }), ctx(id));

  test('list: owner sees own team; staff 403; admin needs business_id; cross-tenant is 404', async () => {
    const own = await team.GET(req('/api/team', asUser('ownerA')));
    expect(own.status).toBe(200);
    const data = (await own.json()).data;
    expect(data.users.map((u: any) => u.email).sort()).toEqual([email('ownerA'), email('owner2A'), email('staffA')].sort());
    expect(JSON.stringify(data)).not.toMatch(/password|hash|secret/i);
    expect((await team.GET(req('/api/team', asUser('staffA')))).status).toBe(403);
    expect((await team.GET(req(`/api/team?business_id=${B}`, asUser('ownerA')))).status).toBe(404);
    expect((await team.GET(req('/api/team', { headers: ADMIN }))).status).toBe(422);
    const adm = await team.GET(req(`/api/team?business_id=${B}`, { headers: ADMIN }));
    expect((await adm.json()).data.users.length).toBe(2);
    expect((await team.GET(req('/api/team'))).status).toBe(401);
  });

  test('tenant isolation: an owner cannot touch another business\'s users, invites or sessions (404)', async () => {
    expect((await patch('ownerA', ids.staffB, { role: 'owner' })).status).toBe(404);
    expect((await patch('ownerA', ids.staffB, { disabled: true }, `?business_id=${B}`)).status).toBe(404);
    expect((await userRoute.DELETE(req(`/api/team/users/${ids.staffB}`, { method: 'DELETE', ...asUser('ownerA') }), ctx(ids.staffB))).status).toBe(404);
    expect((await revokeRoute.POST(req(`/api/team/users/${ids.staffB}/revoke-sessions`, { method: 'POST', ...asUser('ownerA') }), ctx(ids.staffB))).status).toBe(404);
    expect((await db.getUserById(ids.staffB)).disabled_at).toBeNull();
    expect((await s.resolvePrincipal(new Headers({ cookie: cookies.staffB }))).ok).toBe(true);
    // invites of B
    const inv = await db.createEmailToken({ purpose: 'invite', email: email('pend'), business_id: B, role: 'staff', invited_by: ids.ownerB });
    expect((await inviteId.DELETE(req(`/api/team/invites/${inv.record.id}`, { method: 'DELETE', ...asUser('ownerA') }), ctx(inv.record.id))).status).toBe(404);
    expect((await resendRoute.POST(req(`/api/team/invites/${inv.record.id}/resend`, { method: 'POST', ...asUser('ownerA') }), ctx(inv.record.id))).status).toBe(404);
    expect(await db.peekEmailToken('invite', inv.token)).not.toBeNull();
    // an admin account is not a team member
    expect((await patch('ownerA', ids.root, { role: 'staff' })).status).toBe(404);
    expect((await userRoute.DELETE(req(`/api/team/users/${ids.root}`, { method: 'DELETE', headers: ADMIN }), ctx(ids.root))).status).toBe(404);
  });

  test('staff cannot use any team mutation (403)', async () => {
    expect((await patch('staffA', ids.owner2A, { disabled: true })).status).toBe(403);
    expect((await userRoute.DELETE(req(`/api/team/users/${ids.owner2A}`, { method: 'DELETE', ...asUser('staffA') }), ctx(ids.owner2A))).status).toBe(403);
    expect((await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('z'), role: 'staff' }, ...asUser('staffA') }))).status).toBe(403);
    expect((await auditRoute.GET(req('/api/team/audit', asUser('staffA')))).status).toBe(403);
  });

  test('CSRF: cross-site cookie mutations are refused; Bearer is exempt', async () => {
    const cross = await userRoute.PATCH(req(`/api/team/users/${ids.staffA}`, { method: 'PATCH', json: { disabled: true }, headers: { cookie: cookies.ownerA, 'sec-fetch-site': 'cross-site' } }), ctx(ids.staffA));
    expect(cross.status).toBe(403);
    const bare = await userRoute.PATCH(new Request(`http://app.test/api/team/users/${ids.staffA}`, { method: 'PATCH', headers: { cookie: cookies.ownerA, 'content-type': 'application/json' }, body: '{"disabled":true}' }), ctx(ids.staffA));
    expect(bare.status).toBe(403);
    expect((await db.getUserById(ids.staffA)).disabled_at).toBeNull();
    const bearer = await userRoute.PATCH(req(`/api/team/users/${ids.staffA}?business_id=${A}`, { method: 'PATCH', json: { role: 'staff' }, headers: ADMIN }), ctx(ids.staffA));
    expect(bearer.status).toBe(200);
  });

  test('a role change signs the target out everywhere, MFA-pending sessions included; changing your own role keeps your own session', async () => {
    const extra = await db.createUser({ email: email('rolechg'), password_hash: await pw.hashPassword(PASSWORD), role: 'staff', business_id: A, email_verified: true });
    ids.rolechg = extra.id;
    const s1 = (await db.createSession(extra.id)).token;
    const s2 = (await db.createSession(extra.id)).token; // stands in for a pending session: any row of the user must go
    expect((await patch('ownerA', extra.id, { role: 'owner' })).status).toBe(200);
    for (const t of [s1, s2]) expect((await s.resolvePrincipal(new Headers({ cookie: `rc_user_session=${t}` }))).ok).toBe(false);
    expect(await db.prisma.userSession.count({ where: { userId: extra.id } })).toBe(0);
    // no change => nothing revoked
    const keep = (await db.createSession(extra.id)).token;
    expect((await patch('ownerA', extra.id, { role: 'owner' })).status).toBe(200);
    expect((await s.resolvePrincipal(new Headers({ cookie: `rc_user_session=${keep}` }))).ok).toBe(true);
    // self-demotion keeps the caller's own session, kills the rest
    const other = (await db.createSession(extra.id)).token;
    const res = await userRoute.PATCH(req(`/api/team/users/${extra.id}`, { method: 'PATCH', json: { role: 'staff' }, headers: { cookie: `rc_user_session=${keep}` } }), ctx(extra.id));
    expect(res.status).toBe(200);
    expect((await s.resolvePrincipal(new Headers({ cookie: `rc_user_session=${other}` }))).ok).toBe(false);
  });

  test('role change, disable (revokes sessions), enable, remove; audited', async () => {
    const r = await patch('ownerA', ids.staffA, { role: 'owner' });
    expect(r.status).toBe(200);
    expect((await db.getUserById(ids.staffA)).role).toBe('owner');
    expect((await patch('ownerA', ids.staffA, { role: 'staff' })).status).toBe(200);
    expect((await patch('ownerA', ids.staffA, { role: 'admin' })).status).toBe(422);
    expect((await patch('ownerA', ids.staffA, {})).status).toBe(422);
    const dis = await patch('ownerA', ids.staffA, { disabled: true });
    expect(dis.status).toBe(200);
    expect((await s.resolvePrincipal(new Headers({ cookie: cookies.staffA }))).ok).toBe(false);
    expect((await patch('ownerA', ids.staffA, { disabled: false })).status).toBe(200);
    const audit = (await db.listAuditEvents({ business_id: A })).map((a: any) => a.action);
    expect(['user.role_changed', 'user.disabled', 'user.enabled'].every((a) => audit.includes(a))).toBe(true);
    // revoke sessions
    await clearLimiter(db, ['auth/login']);
    cookies.staffA = cookieFrom(await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('staffA'), password: PASSWORD } }))) as string;
    const rv = await revokeRoute.POST(req(`/api/team/users/${ids.staffA}/revoke-sessions`, { method: 'POST', ...asUser('ownerA') }), ctx(ids.staffA));
    expect((await rv.json()).data.revoked).toBeGreaterThanOrEqual(1);
    expect((await s.resolvePrincipal(new Headers({ cookie: cookies.staffA }))).ok).toBe(false);
    // you cannot disable or remove yourself
    expect((await patch('ownerA', ids.ownerA, { disabled: true })).status).toBe(400);
    expect((await userRoute.DELETE(req(`/api/team/users/${ids.ownerA}`, { method: 'DELETE', ...asUser('ownerA') }), ctx(ids.ownerA))).status).toBe(400);
    // remove
    const gone = await db.createUser({ email: email('gone'), password_hash: await pw.hashPassword(PASSWORD), role: 'staff', business_id: A });
    expect((await userRoute.DELETE(req(`/api/team/users/${gone.id}`, { method: 'DELETE', ...asUser('ownerA') }), ctx(gone.id))).status).toBe(200);
    expect(await db.getUserById(gone.id)).toBeNull();
  });

  test('last owner protection: cannot demote, disable or remove the only active owner; allowed with a second owner', async () => {
    const solo = `biz_solo_${run}`;
    await db.prisma.business.create({ data: { id: solo, name: 'Solo', status: 'live' } });
    try {
      const hash = await pw.hashPassword(PASSWORD);
      const o = await db.createUser({ email: email('solo'), password_hash: hash, role: 'owner', business_id: solo, email_verified: true });
      const q = `?business_id=${solo}`;
      const p = (json: unknown) => userRoute.PATCH(req(`/api/team/users/${o.id}${q}`, { method: 'PATCH', json, headers: ADMIN }), ctx(o.id));
      for (const r of [await p({ role: 'staff' }), await p({ disabled: true })]) {
        expect(r.status).toBe(409);
        expect((await r.json()).code).toBe('last_owner');
      }
      expect((await userRoute.DELETE(req(`/api/team/users/${o.id}${q}`, { method: 'DELETE', headers: ADMIN }), ctx(o.id))).status).toBe(409);
      expect((await db.getUserById(o.id)).role).toBe('owner');

      const o2 = await db.createUser({ email: email('solo2'), password_hash: hash, role: 'owner', business_id: solo, email_verified: true });
      // two owners racing to demote each other: exactly one may succeed
      const pp = (id: string) => userRoute.PATCH(req(`/api/team/users/${id}${q}`, { method: 'PATCH', json: { role: 'staff' }, headers: ADMIN }), ctx(id));
      const results = await Promise.all([pp(o.id), pp(o2.id)]);
      expect(results.map((r: Response) => r.status).sort()).toEqual([200, 409]);
      expect(await db.prisma.user.count({ where: { businessId: solo, role: 'owner' } })).toBe(1);
      // a disabled second owner does not count as an active owner
      const survivor = (await db.prisma.user.findFirst({ where: { businessId: solo, role: 'owner' } })).id;
      const other = survivor === o.id ? o2.id : o.id;
      expect((await userRoute.PATCH(req(`/api/team/users/${other}${q}`, { method: 'PATCH', json: { role: 'owner' }, headers: ADMIN }), ctx(other))).status).toBe(200);
      expect((await userRoute.PATCH(req(`/api/team/users/${other}${q}`, { method: 'PATCH', json: { disabled: true }, headers: ADMIN }), ctx(other))).status).toBe(200);
      expect((await userRoute.PATCH(req(`/api/team/users/${survivor}${q}`, { method: 'PATCH', json: { disabled: true }, headers: ADMIN }), ctx(survivor))).status).toBe(409);
    } finally {
      await db.prisma.user.deleteMany({ where: { businessId: solo } });
      await db.prisma.business.deleteMany({ where: { id: solo } });
    }
  });

  test('pending invitations list, resend (new link, old one dies) and revoke (link dies)', async () => {
    await clearLimiter(db, ['team/invite']);
    const e = email('pend2');
    const res = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: e, role: 'staff' }, ...asUser('ownerA') }));
    expect(res.status).toBe(201);
    const first = mail.to(e).at(-1)!.token as string;
    const list = (await (await team.GET(req('/api/team', asUser('ownerA')))).json()).data.invites;
    const mine = list.find((i: any) => i.email === e);
    expect(mine.role).toBe('staff');
    expect(mine.invited_by_email).toBe(email('ownerA'));
    expect(JSON.stringify(list)).not.toContain(first);
    const re = await resendRoute.POST(req(`/api/team/invites/${mine.id}/resend`, { method: 'POST', ...asUser('ownerA') }), ctx(mine.id));
    expect(re.status).toBe(200);
    const second = mail.to(e).at(-1)!.token as string;
    expect(second).not.toBe(first);
    expect(await db.peekEmailToken('invite', first)).toBeNull();
    const newId = (await (await team.GET(req('/api/team', asUser('ownerA')))).json()).data.invites.find((i: any) => i.email === e).id;
    expect((await inviteId.DELETE(req(`/api/team/invites/${newId}`, { method: 'DELETE', ...asUser('ownerA') }), ctx(newId))).status).toBe(200);
    expect(await db.peekEmailToken('invite', second)).toBeNull();
    expect((await inviteId.DELETE(req(`/api/team/invites/${newId}`, { method: 'DELETE', ...asUser('ownerA') }), ctx(newId))).status).toBe(404);
  });

  test('audit viewer: owners only see their business; admins see all; cursor pagination; no secrets', async () => {
    for (let i = 0; i < 3; i++) await db.recordAudit({ actor_kind: 'system', business_id: A, action: `test.a${i}`, target: 'x', at: new Date(Date.now() + i * 1000) });
    await db.recordAudit({ actor_kind: 'system', business_id: B, action: 'test.b', target: 'x' });
    await db.recordAudit({ actor_kind: 'system', business_id: A, action: 'test.secret', meta: { password: 'hunter2hunter2', token: 'abc' } });
    const get = (n: string | null, q = '') => auditRoute.GET(req(`/api/team/audit${q}`, n ? asUser(n) : { headers: ADMIN }));
    const own = (await (await get('ownerA', '?limit=100')).json()).data.events;
    expect(own.every((e: any) => e.business_id === A)).toBe(true);
    expect(own.some((e: any) => e.action === 'test.b')).toBe(false);
    expect(JSON.stringify(own)).not.toContain('hunter2');
    expect((await get('ownerA', `?business_id=${B}`)).status).toBe(404);
    const all = (await (await get(null, '?limit=100')).json()).data.events;
    expect(all.some((e: any) => e.action === 'test.b')).toBe(true);
    const scoped = (await (await get(null, `?business_id=${B}&limit=100`)).json()).data.events;
    expect(scoped.every((e: any) => e.business_id === B)).toBe(true);
    // pagination
    const p1 = (await (await get('ownerA', '?limit=2')).json()).data;
    expect(p1.events.length).toBe(2);
    expect(p1.next_before).toBeTruthy();
    const p2 = (await (await get('ownerA', `?limit=2&before=${encodeURIComponent(p1.next_before)}`)).json()).data;
    expect(p2.events.every((e: any) => e.at <= p1.next_before.split('~')[0])).toBe(true);
    expect(p2.events.some((e: any) => p1.events.some((x: any) => x.id === e.id))).toBe(false);
    expect((await get('ownerA', '?before=garbage')).status).toBe(422);
    expect((await get('ownerA', '?before=2026-01-01T00:00:00.000Z~bad%20id')).status).toBe(422);
  });

  test('audit viewer: events sharing one timestamp are neither skipped nor repeated across pages (at,id cursor)', async () => {
    const C = `biz_tc_${run}`;
    await db.prisma.business.create({ data: { id: C, name: `Team ${C}`, status: 'live' } });
    try {
      const at = new Date(Date.now() + 3_600_000);
      for (let i = 0; i < 7; i++) await db.recordAudit({ actor_kind: 'system', business_id: C, action: `tie.${i}`, target: 'x', at });
      await db.recordAudit({ actor_kind: 'system', business_id: C, action: 'tie.older', target: 'x', at: new Date(at.getTime() - 5000) });
      const seen: string[] = [];
      let before: string | null = null;
      for (let page = 0; page < 10; page++) {
        const q: string = `?business_id=${C}&limit=3${before ? `&before=${encodeURIComponent(before)}` : ''}`;
        const data = (await (await auditRoute.GET(req(`/api/team/audit${q}`, { headers: ADMIN }))).json()).data;
        seen.push(...data.events.map((e: any) => e.action));
        before = data.next_before;
        if (!before) break;
      }
      expect(seen.length).toBe(8);
      expect(new Set(seen).size).toBe(8);
      expect(seen[seen.length - 1]).toBe('tie.older');
      // legacy bare-timestamp cursor still works (strictly older rows)
      const legacy = (await (await auditRoute.GET(req(`/api/team/audit?business_id=${C}&limit=50&before=${encodeURIComponent(at.toISOString())}`, { headers: ADMIN }))).json()).data;
      expect(legacy.events.map((e: any) => e.action)).toEqual(['tie.older']);
    } finally {
      await db.prisma.auditEvent.deleteMany({ where: { businessId: C } });
      await db.prisma.business.deleteMany({ where: { id: C } });
    }
  });

  test('an admin user (DB role) can manage any business; the business switcher is just business_id', async () => {
    const r = await team.GET(req(`/api/team?business_id=${A}`, asUser('root')));
    expect(r.status).toBe(200);
    expect((await patch('root', ids.staffA, { role: 'staff' }, `?business_id=${A}`)).status).toBe(200);
  });
});
