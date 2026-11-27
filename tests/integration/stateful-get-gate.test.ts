/**
 * State-changing GET routes (Google connect / callback, the demo billing activation) go through the support write gate exactly like a POST: an admin USER needs an open support
 * grant for EXACTLY the business named (owner / ops per the permission matrix; the support role gets `support_scope`; read_only is forbidden). A plain tenant owner is unchanged.
 */
import { integration, outboundCalls, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { cleanup, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

integration('stateful GET routes pass the support write gate (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let R: Record<string, any> = {};
  const userIds: string[] = [];
  const ORIGIN = 'https://app.example.test';
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  type Who = { cookie: string; user: { id: string } };

  const admin = async (role: 'owner' | 'ops' | 'support' | 'read_only'): Promise<Who> => {
    const user = await users.createUser({ email: `${uniq('adm')}@example.test`, password_hash: 'x'.repeat(20), role: 'admin', email_verified: true, platform_role: role });
    userIds.push(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: 'v1.a.b.c', totpEnabledAt: new Date() } });
    const { token, session } = await users.createSession(user.id);
    await users.markSessionMfaVerified(session.id);
    await prisma.userSession.updateMany({ where: { userId: user.id }, data: { sudoAt: new Date() } });
    return { user: { id: user.id }, cookie: `rc_user_session=${token}` };
  };
  const tenantOwner = async (businessId: string): Promise<Who> => {
    const user = await users.createUser({ email: `${uniq('own')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { user: { id: user.id }, cookie: `rc_user_session=${token}` };
  };
  const get = async (handler: (req: Request) => Promise<Response>, path: string, who: Who) => {
    const res = await handler(new Request(`${ORIGIN}${path}`, { method: 'GET', headers: { 'sec-fetch-site': 'same-origin', cookie: who.cookie } }));
    let code: string | undefined;
    try { code = (await res.clone().json()).code; } catch { /* a redirect has no body */ }
    return { status: res.status, code };
  };
  const grant = (who: Who, businessId: string) => prisma.supportGrant.create({ data: { id: crypto.randomUUID(), userId: who.user.id, businessId, reason: 'stateful GET gate test', startedAt: new Date(), expiresAt: new Date(Date.now() + 1_800_000) } });

  beforeAll(async () => {
    setEnv('APP_SECRET_KEY', crypto.randomBytes(32).toString('base64'));
    for (const [k, v] of Object.entries({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', APP_URL: ORIGIN, DEMO_MODE: 'true', GOOGLE_OAUTH_MOCK: undefined, STRIPE_SECRET_KEY: undefined })) setEnv(k, v);
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    R = {
      connect: (await import('@/app/api/integrations/google/connect/route')).GET,
      callback: (await import('@/app/api/integrations/google/callback/route')).GET,
      mock: (await import('@/app/api/billing/mock-activate/route')).GET,
    };
  });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    await prisma.supportGrant.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await cleanup();
  });

  test('connect / callback / mock-activate: no grant and a grant for another business are refused; a grant for this business passes', async () => {
    await withEnv({ NODE_ENV: 'test' }, async () => {
      const A = await newBusiness({ agent_id: null }); const B = await newBusiness({ agent_id: null });
      const ops = await admin('ops'); const owner = await admin('owner'); const sup = await admin('support'); const ro = await admin('read_only');
      const paths = { connect: `/api/integrations/google/connect?business_id=${B.id}`, callback: `/api/integrations/google/callback?business_id=${B.id}&code=x&state=y`, mock: `/api/billing/mock-activate?business_id=${B.id}` } as const;
      for (const [name, path] of Object.entries(paths)) {
        const h = R[name];
        for (const who of [ops, owner]) expect([name, (await get(h, path, who)).code]).toEqual([name, 'support_write_required']);
        expect([name, (await get(h, path, ro)).code]).toEqual([name, 'forbidden']);
      }
      await grant(ops, A.id); await grant(owner, A.id); // a grant for ANOTHER business changes nothing
      for (const [name, path] of Object.entries(paths)) for (const who of [ops, owner]) expect([name, (await get(R[name], path, who)).code]).toEqual([name, 'support_write_required']);
      // nothing was attached to B
      expect(await prisma.calendarConnection.count({ where: { businessId: B.id } })).toBe(0);

      await grant(ops, B.id); await grant(owner, B.id); await grant(sup, B.id);
      for (const who of [ops, owner]) {
        const r = await get(R.connect, paths.connect, who);
        expect([r.status, r.code]).toEqual([302, undefined]); // through the gate: the redirect to Google
        expect(['support_write_required', 'support_scope', 'forbidden']).not.toContain((await get(R.callback, paths.callback, who)).code);
      }
      // the support role is not owner write, grant or not
      for (const [name, path] of Object.entries(paths)) expect([name, (await get(R[name], path, sup)).code]).toEqual([name, 'support_scope']);
      expect((await prisma.business.findUnique({ where: { id: B.id }, select: { billingStatus: true } }))?.billingStatus ?? 'none').not.toBe('trialing');
    });
  });

  test('a plain tenant owner is unchanged (own business passes; another business is a 404)', async () => {
    await withEnv({ NODE_ENV: 'test' }, async () => {
      const A = await newBusiness({ agent_id: null }); const B = await newBusiness({ agent_id: null });
      const own = await tenantOwner(A.id);
      expect((await get(R.connect, `/api/integrations/google/connect?business_id=${A.id}`, own)).status).toBe(302);
      expect((await get(R.connect, `/api/integrations/google/connect`, own)).status).toBe(302);
      expect((await get(R.connect, `/api/integrations/google/connect?business_id=${B.id}`, own)).status).toBe(404);
    });
  });

  test('revoke-sessions: an admin USER with a grant for A signs a member out of A only; without a grant (or with a grant for another business) it is refused', async () => {
    const A = await newBusiness({ agent_id: null }); const B = await newBusiness({ agent_id: null });
    const member = await users.createUser({ email: `${uniq('mem')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: A.id, email_verified: true });
    userIds.push(member.id);
    await prisma.membership.create({ data: { userId: member.id, businessId: B.id, role: 'staff' } });
    const sessA = (await users.createSession(member.id)).session; const sessB = (await users.createSession(member.id)).session;
    await prisma.userSession.update({ where: { id: sessA.id }, data: { activeBusinessId: A.id } });
    await prisma.userSession.update({ where: { id: sessB.id }, data: { activeBusinessId: B.id } });
    const ops = await admin('ops');
    const revoke = (await import('@/app/api/team/users/[id]/revoke-sessions/route')).POST;
    const post = async (who: Who, biz: string) => revoke(new Request(`${ORIGIN}/api/team/users/${member.id}/revoke-sessions?business_id=${biz}`, { method: 'POST', headers: { cookie: who.cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ id: member.id }) });
    expect((await post(ops, A.id)).status).toBe(403);
    await grant(ops, B.id);
    expect((await post(ops, A.id)).status).toBe(403); // a grant for B does not reach A
    await grant(ops, A.id);
    expect((await post(ops, A.id)).status).toBe(200);
    expect(await prisma.userSession.findUnique({ where: { id: sessA.id } })).toBeNull();
    expect(await prisma.userSession.findUnique({ where: { id: sessB.id } })).not.toBeNull(); // the session working in B survives
  });
});
