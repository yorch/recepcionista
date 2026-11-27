import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { acknowledgeAlert, unacknowledgeAlert } from '@/lib/admin/alerts';
import { SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { id, hours?: 1..336 (default 24), reason? } acknowledges an OPEN alert: it is silenced until it expires or the problem grows. DELETE { id } withdraws it.
 * Audited (`alerts.acknowledged`). Permission: jobs.run (owner, ops, the break-glass token); step-up for a cookie session.
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'jobs.run', write: true, rate: { name: 'alerts-ack', max: 30 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req);
    if (typeof body.id !== 'string') throw new SettingsError(422, 'invalid_body', 'id is required');
    if (body.hours !== undefined && typeof body.hours !== 'number') throw new SettingsError(422, 'invalid_body', 'hours must be a number');
    if (body.reason !== undefined && typeof body.reason !== 'string') throw new SettingsError(422, 'invalid_body', 'reason must be a string');
    return ok(await acknowledgeAlert({ id: body.id, hours: body.hours as number | undefined, reason: body.reason as string | undefined, actor: g.ctx.actor }));
  } catch (err) { return adminFail(err); }
}

export async function DELETE(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'jobs.run', write: true, rate: { name: 'alerts-ack', max: 30 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req);
    if (typeof body.id !== 'string') throw new SettingsError(422, 'invalid_body', 'id is required');
    await unacknowledgeAlert({ id: body.id, actor: g.ctx.actor });
    return ok({ id: body.id, acknowledged: false });
  } catch (err) { return adminFail(err); }
}
