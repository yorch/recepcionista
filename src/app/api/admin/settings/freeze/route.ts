import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { freezeState, setFrozen, SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET: the freeze state (`by_env` = SETTINGS_FREEZE=true, which no API can lift). Permission: settings.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'settings-freeze', max: 60 } });
  if (!g.ok) return g.response;
  try { return ok(await freezeState()); } catch (err) { return adminFail(err); }
}

/**
 * POST { frozen: boolean, reason }: the incident switch. While frozen EVERY console write (settings, secrets, plans, legal pages, tenant overrides, imports, rollbacks)
 * answers 403 `settings_frozen`. Freezing: owner, ops and the break-glass token. Unfreezing: owner and the break-glass token only. Both are audited and mailed to every admin.
 * Permission: settings.freeze (freeze) / settings.unfreeze (unfreeze).
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: ['settings.freeze', 'settings.unfreeze'], write: true, rate: { name: 'settings-freeze', max: 10 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req);
    if (typeof body.frozen !== 'boolean') throw new SettingsError(422, 'invalid_body', 'frozen must be true or false');
    return ok(await setFrozen({ frozen: body.frozen, reason: typeof body.reason === 'string' ? body.reason : '', actor: g.ctx.actor }));
  } catch (err) { return adminFail(err); }
}
