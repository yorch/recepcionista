import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { describeSettings } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The registry with the EFFECTIVE value of every setting, where it comes from (`source`: env | console | default), whether it is locked (an environment pin), its
 * schema and rules, and, for secrets, metadata only (set / source / fingerprint / last 4 / when / who; never the value; hidden from read_only and support).
 * Also the global settings `version` and the freeze state. Permission: settings.read.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'settings', max: 120 } });
  if (!g.ok) return g.response;
  try { return ok(await describeSettings({ revealSecretMeta: g.ctx.revealSecretMeta })); } catch (err) { return adminFail(err); }
}
