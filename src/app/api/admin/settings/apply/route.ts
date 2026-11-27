import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { applyChanges, SettingsError, type SettingChange } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { changes, reason?, confirm?, expected_version?, dry_run? } applies ONE change set atomically (all keys or none).
 * normal tier: step-up. sensitive: + `reason` (8-500 chars). critical (credentials, billing enforcement, country lists, jobs, email): + `confirm` = the exact phrase the preview
 * returned, and every admin (and ALERT_EMAIL) is mailed through the transport that was active BEFORE the change. Locked keys 409 `locked_by_env`; ratchet loosening 422
 * `ratchet_violation`; credential pairs 409 `pair_required`; a stale `expected_version` 409 `stale_preview`; the freeze 403 `settings_frozen`.
 * Every key is checked against the caller's role (a critical key needs settings.write.critical, a secret settings.secrets.write; the break-glass token needs
 * ADMIN_TOKEN_ALLOW_SETTINGS=true for both). Audited as `settings.change` (values redacted by kind). Permission: settings.write (+ per key as above).
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: ['settings.write', 'settings.write.critical', 'settings.secrets.write'], write: true, frozenBlocks: true, rate: { name: 'settings-apply', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.changes)) throw new SettingsError(422, 'invalid_body', 'changes must be an array');
    if (body.expected_version !== undefined && !Number.isInteger(body.expected_version)) throw new SettingsError(422, 'invalid_body', 'expected_version must be an integer');
    const res = await applyChanges({
      changes: body.changes as SettingChange[], reason: typeof body.reason === 'string' ? body.reason : undefined, confirm: typeof body.confirm === 'string' ? body.confirm : undefined,
      expectedVersion: body.expected_version as number | undefined, dryRun: body.dry_run === true, actor: g.ctx.actor,
    });
    return ok(res);
  } catch (err) { return adminFail(err); }
}
