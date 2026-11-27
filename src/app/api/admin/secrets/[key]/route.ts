import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { removeSecret, secretInfo, setSecret, SettingsError, type ApplyResult } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ key: string }> };

/** The part of an apply result that is safe to return for a secret: never a value, only fingerprints. */
const safe = (r: ApplyResult) => ({ change_set_id: r.change_set_id, version: r.version, tier: r.tier, noop: r.noop, notified: r.notified, changes: r.changes });

/** GET: what the console may know about this secret (set? from env or console? fingerprint, last 4, when, who). NEVER the value. Permission: settings.read. */
export async function GET(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'secrets', max: 60 } });
  if (!g.ok) return g.response;
  try { return ok(await secretInfo((await params).key, { revealMeta: g.ctx.revealSecretMeta })); } catch (err) { return adminFail(err); }
}

/**
 * PUT { value, reason, confirm, paired?: { <partner key>: <value> } } replaces (or first sets) a secret. WRITE-ONLY: the response carries a fingerprint, never the value.
 * A credential pair must travel together (`paired`), e.g. twilio.account_sid + twilio.auth_token. The previous value stays accepted by webhook verifiers for 15 minutes and
 * recoverable for rollback for 7 days. Critical tier: step-up + reason + typed confirmation (the key name) + every admin mailed. A key pinned by the environment is 409
 * `locked_by_env`. Permission: settings.secrets.write (owner; the break-glass token only with ADMIN_TOKEN_ALLOW_SETTINGS=true).
 */
export async function PUT(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'settings.secrets.write', write: true, frozenBlocks: true, rate: { name: 'secrets-write', max: 10 } });
  if (!g.ok) return g.response;
  try {
    const key = (await params).key;
    const body = await readBody(req);
    if (typeof body.value !== 'string') throw new SettingsError(422, 'invalid_value', 'value must be a string');
    let paired: Record<string, string> | undefined;
    if (body.paired !== undefined) {
      if (!body.paired || typeof body.paired !== 'object' || Array.isArray(body.paired) || Object.values(body.paired).some((v) => typeof v !== 'string')) throw new SettingsError(422, 'invalid_body', 'paired must be an object of strings');
      paired = body.paired as Record<string, string>;
    }
    return ok(safe(await setSecret({ key, value: body.value, paired, reason: typeof body.reason === 'string' ? body.reason : '', confirm: typeof body.confirm === 'string' ? body.confirm : undefined, actor: g.ctx.actor })));
  } catch (err) { return adminFail(err); }
}

/** DELETE { reason, confirm }: remove the console value (the environment value, if any, applies again). Same rules as PUT. Permission: settings.secrets.write. */
export async function DELETE(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'settings.secrets.write', write: true, frozenBlocks: true, rate: { name: 'secrets-write', max: 10 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
    return ok(safe(await removeSecret({ key: (await params).key, reason: typeof body.reason === 'string' ? body.reason : '', confirm: typeof body.confirm === 'string' ? body.confirm : undefined, actor: g.ctx.actor })));
  } catch (err) { return adminFail(err); }
}
