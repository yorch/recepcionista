import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { reencryptAll, reencryptStatus } from '@/lib/admin/rotation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET: what is still encrypted under an older key (settings, retained previous envelopes, TOTP secrets, calendar tokens). Permission: system.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'system.read', rate: { name: 'reencrypt', max: 30 } });
  if (!g.ok) return g.response;
  try { return ok(await reencryptStatus()); } catch (err) { return adminFail(err); }
}

/**
 * POST { reason, cursor? }: APP_SECRET_KEY rotation step 2. Re-encrypts every console secret (and re-signs MACs), the retained previous envelopes, the canary, TOTP secrets and
 * calendar tokens under the CURRENT key. Repeat with the returned `next_cursor` until `done: true`, then remove APP_SECRET_KEY_PREVIOUS. Audited as `settings.reencrypt`
 * (counts and key ids only). Permission: settings.secrets.write.
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.secrets.write', write: true, frozenBlocks: true, rate: { name: 'reencrypt', max: 6 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req);
    return ok(await reencryptAll({ actor: g.ctx.actor, reason: typeof body.reason === 'string' ? body.reason : '', cursor: typeof body.cursor === 'string' ? body.cursor : null }));
  } catch (err) { return adminFail(err); }
}
