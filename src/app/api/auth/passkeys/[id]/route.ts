import { NextResponse } from 'next/server';
import { afterResponse, auditIp, sendPasskeyNotice } from '@/lib/account-flows';
import { deletePasskey, listPasskeys, recordAudit, renamePasskey } from '@/lib/db';
import { accountOf, auditBusinessOf, pkFail } from '@/lib/passkey-http';
import { authenticate, requireRecentAuth } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH { name }: rename one of the caller's own passkeys (another account's id is a 404). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = accountOf(auth.principal);
  if (!user) return pkFail(403, 'passkeys belong to personal accounts');
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80) : '';
  if (!name) return pkFail(422, 'name is required');
  if (id.length > 64 || !(await renamePasskey(user.id, id, name))) return pkFail(404, 'passkey not found');
  await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: auditBusinessOf(auth.principal), action: 'auth.passkey_renamed', target: `passkey:${id}`, ip: auditIp(req) });
  return NextResponse.json({ ok: true, data: { renamed: true, name } });
}

/**
 * DELETE: remove one of the caller's own passkeys. Needs a recent proof of identity (403 `reauth_required`; a passkey step-up counts).
 * The account cannot be locked out by this: every account keeps its password (and its authenticator app, if any).
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = accountOf(auth.principal);
  if (!user) return pkFail(403, 'passkeys belong to personal accounts');
  const stale = requireRecentAuth(auth);
  if (stale) return stale;
  const { id } = await ctx.params;
  const mine = id.length <= 64 ? (await listPasskeys(user.id)).find((p) => p.id === id) : undefined;
  if (!mine || !(await deletePasskey(user.id, id))) return pkFail(404, 'passkey not found');
  await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: auditBusinessOf(auth.principal), action: 'auth.passkey_removed', target: `passkey:${id}`, ip: auditIp(req) });
  await afterResponse('passkey.removed_notice', () => sendPasskeyNotice(user.email, 'removed', mine.name));
  return NextResponse.json({ ok: true, data: { removed: true } });
}
