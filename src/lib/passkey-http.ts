/** Shared plumbing of the /api/auth/passkeys/** routes. Node runtime only. */
import { NextResponse } from 'next/server';
import { afterResponse, auditIp, sendPasskeyCloneNotice } from '@/lib/account-flows';
import { deleteUserSessions, recordAudit } from '@/lib/db';
import { webauthnConfigFor, type WebauthnConfig } from '@/lib/webauthn';
import type { Principal } from '@/lib/session';
import type { PasskeySummary, User } from '@/lib/types';

export const pkFail = (status: number, error: string, code?: string, headers?: Record<string, string>) =>
  NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status, headers });

/** Relying-party config for this request, or the 503 to send when passkeys are not configured. */
export function configOr503(req: Request): { cfg: WebauthnConfig } | { response: NextResponse } {
  const cfg = webauthnConfigFor(req);
  return cfg ? { cfg } : { response: pkFail(503, 'passkeys are not configured on this server', 'passkeys_not_configured') };
}

/** The account behind a principal that can hold passkeys: a tenant user or a DB admin user (not the break-glass token). */
export function accountOf(p: Principal): User | null {
  return p.kind === 'user' ? p.user : p.user ?? null;
}

/** The business to file an account-level audit row under (the session's active business; admins have none). */
export const auditBusinessOf = (p: Principal): string | null => (p.kind === 'user' ? p.business_id : null);

/**
 * A passkey's signature counter went backwards: the authenticator was probably cloned. Sign the account out everywhere, leave an audit
 * trail and tell the owner of the mailbox. (The sign-in itself is refused by the caller with the usual generic answer.)
 */
export async function handleClonedPasskey(req: Request, user: User, passkey: PasskeySummary): Promise<void> {
  await deleteUserSessions(user.id);
  await recordAudit({
    actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.passkey_clone_suspected', target: `user:${user.id}`,
    ip: auditIp(req), meta: { passkey_id: passkey.id, sessions_revoked: true },
  });
  await afterResponse('passkey.clone_notice', () => sendPasskeyCloneNotice(user.email, passkey.name));
}
