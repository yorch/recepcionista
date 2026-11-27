import { NextResponse } from 'next/server';
import { ok } from '@/lib/http';
import { recordAudit } from '@/lib/db/audit';
import { guardAdminRoute, adminFail, int } from '@/lib/admin/guard';
import { AUDIT_EXPORT_MAX, auditCsv, searchAudit } from '@/lib/admin/audit-search';
import { can } from '@/lib/admin/permissions';
import { SettingsError } from '@/lib/admin/settings-store';
import { enrichAudit } from '@/lib/admin/audit-enrich';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Audit search: GET ?actor=<user id|admin_token|system|webhook>&action=<exact | prefix.>&business_id=&from=&to=&q=<text>&before=<cursor>&limit=1..200.
 * `format=csv|json&export=1` downloads up to 5000 rows (permission audit.export, rate limited 6/min, and the export itself is audited as `audit.export`).
 * Permission: audit.read (search), audit.export (download).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const exporting = q.get('export') === '1' || q.get('export') === 'true';
  const g = await guardAdminRoute(req, { permission: exporting ? 'audit.export' : 'audit.read', rate: exporting ? { name: 'audit-export', max: 6 } : { name: 'audit', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const query = { actor: q.get('actor') ?? undefined, action: q.get('action') ?? undefined, business_id: q.get('business_id') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, q: q.get('q') ?? undefined, before: q.get('before') ?? undefined };
    if (!exporting) {
      const res = await searchAudit({ ...query, limit: int(q.get('limit'), 50, 1, 200) });
      return ok({ ...res, items: await enrichAudit(res.items) }); // + business_name and actor_email for the console table
    }
    if (!can(g.ctx.principal, 'audit.export')) throw new SettingsError(403, 'forbidden', 'not allowed to export');
    const format = q.get('format') === 'csv' ? 'csv' : 'json';
    const res = await searchAudit({ ...query, limit: int(q.get('limit'), 1000, 1, AUDIT_EXPORT_MAX) }, { max: AUDIT_EXPORT_MAX });
    await recordAudit({ actor_kind: g.ctx.actor.kind, actor_user_id: g.ctx.actor.user_id, action: 'audit.export', target: 'audit', ip: g.ctx.ip, meta: { format, rows: res.items.length, filters: Object.fromEntries(Object.entries(query).filter(([k, v]) => v && k !== 'before')), role: g.ctx.role } });
    if (format === 'csv') return new NextResponse(auditCsv(res.items), { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit.csv"', 'cache-control': 'no-store' } });
    return ok(res);
  } catch (err) { return adminFail(err); }
}
