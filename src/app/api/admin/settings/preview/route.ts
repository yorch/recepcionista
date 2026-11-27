import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { previewChanges, type SettingChange } from '@/lib/admin/settings-store';
import { impactsFor } from '@/lib/admin/impact';
import { SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { changes: [{ key, value } | { key, secret } | { key, remove: true }] }: validate a change set and report what applying it would do and require
 * (tier, whether a reason is needed, the exact confirmation phrase of a critical set, who is notified, the current `version` to pass back as expected_version).
 * Writes nothing (read-only POST, so no step-up); a secret is never echoed. Permission: settings.read (the per-key permission of the caller is still checked: a forbidden key is reported).
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'settings-preview', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.changes)) throw new SettingsError(422, 'invalid_body', 'changes must be an array');
    const changes = body.changes as SettingChange[];
    const preview = await previewChanges({ changes, adopt: body.adopt === true, actor: g.ctx.actor });
    // Impact previews (counts of tenants / phones / rows the change would touch): read only, omitted when a preview cannot be computed.
    return ok({ ...preview, impacts: await impactsFor(changes) });
  } catch (err) { return adminFail(err); }
}
