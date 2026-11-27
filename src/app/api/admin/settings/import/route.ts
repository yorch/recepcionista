import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { can } from '@/lib/admin/permissions';
import { importSettings, SettingsError } from '@/lib/admin/settings-store';
import { requireRecentAuth } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { document, apply?: false, reason?, confirm? }. Without `apply: true` it is a DRY RUN: the diff of every key (set / noop / skip with the reason: locked by the
 * environment, secret, unknown, invalid) and of the plans, nothing written. `apply: true` turns it into ONE change set (settings) plus the plan upserts; secrets in the
 * document are ignored. The same tier rules as /settings/apply apply. Permission: settings.read (dry run), settings.import (apply).
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'settings-import', max: 10 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req, 4_000_000);
    const apply = body.apply === true;
    if (apply) {
      if (!can(g.ctx.principal, 'settings.import')) throw new SettingsError(403, 'forbidden', 'not allowed to import settings');
      const stale = requireRecentAuth(g.ctx.auth);
      if (stale) return stale;
    }
    return ok(await importSettings({ doc: body.document, apply, reason: typeof body.reason === 'string' ? body.reason : undefined, confirm: typeof body.confirm === 'string' ? body.confirm : undefined, actor: g.ctx.actor }));
  } catch (err) { return adminFail(err); }
}
