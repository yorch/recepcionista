import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { rollbackChangeSet, SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { change_set_id, reason, confirm?, keys? } reverts a change set by applying its inverse as a NEW change set (history is never rewritten). 409 `superseded` when a key
 * changed again since (roll that back first); 409 `secret_rollback_expired` after the 7-day envelope retention; a ratchet loosening and an environment-locked key are refused.
 * Allowed for the break-glass token (recovery); critical keys and secrets need settings.rollback.critical (owner, token). Permission: settings.rollback.
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.rollback', write: true, frozenBlocks: true, rate: { name: 'settings-rollback', max: 10 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req);
    if (typeof body.change_set_id !== 'string') throw new SettingsError(422, 'invalid_body', 'change_set_id is required');
    if (body.keys !== undefined && (!Array.isArray(body.keys) || body.keys.some((k) => typeof k !== 'string'))) throw new SettingsError(422, 'invalid_body', 'keys must be an array of strings');
    return ok(await rollbackChangeSet({ id: body.change_set_id, reason: typeof body.reason === 'string' ? body.reason : '', confirm: typeof body.confirm === 'string' ? body.confirm : undefined, keys: body.keys as string[] | undefined, actor: g.ctx.actor }));
  } catch (err) { return adminFail(err); }
}
