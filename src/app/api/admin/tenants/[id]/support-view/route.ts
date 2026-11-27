import { NextResponse } from 'next/server';
import { fail } from '@/lib/http';
import { BUSINESS_COOKIE } from '@/lib/auth';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { activeSupportGrant } from '@/lib/admin/support';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST (a read-only POST: it changes no tenant data, so no step-up; it only writes the audit row and the UI preference cookie): open the tenant's dashboard in the READ-ONLY support view. Audited (`support.view_opened`), selects the business for the dashboard shell (the same
 * UI preference cookie the old switcher set; the server still validates it) and answers whether a write grant is open. Writes from the dashboard need the
 * support WRITE mode (POST /support-mode: reason, step-up, 30 minutes); the write gate is src/lib/admin/support-gate.ts. Permission: tenants.read.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'tenants.read', write: false, rate: { name: 'support-view', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const { id } = await params;
    const biz = await prisma.business.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!biz) return fail('business not found', 404);
    const user = g.ctx.principal.user;
    await prisma.auditEvent.create({
      data: auditRowData({ actor_kind: user ? 'user' : 'admin_token', actor_user_id: user?.id ?? null, business_id: id, action: 'support.view_opened', target: `business:${id}`, ip: g.ctx.ip, meta: { role: g.ctx.role, via: g.ctx.principal.via }, meta_trusted: true }),
    });
    const grant = user ? await activeSupportGrant(user.id, id) : null;
    const res = NextResponse.json({ ok: true, data: { business_id: id, name: biz.name, write_mode: grant } });
    res.cookies.set(BUSINESS_COOKIE, id, { path: '/', maxAge: 60 * 60 * 24 * 30, sameSite: 'lax', httpOnly: false, secure: process.env.NODE_ENV === 'production' });
    return res;
  } catch (err) { return adminFail(err); }
}
