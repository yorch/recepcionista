/** Second-factor checks shared by the MFA login step and the security endpoints. Node runtime only. */
import { claimTotpStep, consumeRecoveryCode, getTotpState, getUserByEmail } from '@/lib/db';
import { accountId, checkPair, clearFailures, pairKey, recordFailure, verdictResponse } from '@/lib/login-throttle';
import { verifyPasswordOrDummy } from '@/lib/password';
import { decryptSecret, hashRecoveryCode, looksLikeRecoveryCode, verifyTotp } from '@/lib/totp';

/** A session that only passed the password step must finish the second factor within this long. */
export const MFA_PENDING_TTL_MS = 10 * 60_000;

export type SecondFactor = { ok: true; method: 'totp' | 'recovery' } | { ok: false };

/**
 * Verify a TOTP code (replay-guarded: the matched 30 s step is claimed atomically, so a code works once)
 * or, when `allowRecovery`, a single-use recovery code. Throws SecretKeyError/other when the stored secret
 * cannot be decrypted (callers answer 503): that is a server problem, not a wrong code.
 */
export async function verifySecondFactor(
  userId: string,
  input: { code?: unknown; recovery_code?: unknown },
  opts: { allowRecovery?: boolean; nowMs?: number } = {},
): Promise<SecondFactor> {
  const state = await getTotpState(userId);
  if (!state || !state.enabled_at || !state.secret_enc) return { ok: false };

  if (typeof input.recovery_code === 'string' && input.recovery_code) {
    if (!opts.allowRecovery || input.recovery_code.length > 64 || !looksLikeRecoveryCode(input.recovery_code)) return { ok: false };
    return (await consumeRecoveryCode(userId, hashRecoveryCode(input.recovery_code))) ? { ok: true, method: 'recovery' } : { ok: false };
  }

  if (typeof input.code !== 'string' || input.code.length > 32) return { ok: false };
  const secret = decryptSecret(state.secret_enc, userId);
  const v = verifyTotp(secret, input.code, { lastUsedStep: state.last_used_step, nowMs: opts.nowMs });
  if (!v.ok) return { ok: false };
  return (await claimTotpStep(userId, v.step)) ? { ok: true, method: 'totp' } : { ok: false };
}

// ── Password re-entry for sensitive security actions ────────────────────────────

/**
 * Re-check the signed-in user's password before enabling/disabling 2FA (a stolen session alone must not be
 * enough). Shares the login failure backoff for this (account, client) pair, so it cannot be used to guess
 * the password faster than the login form allows. Returns a Response to send on failure.
 */
export async function reauthWithPassword(req: Request, email: string, password: unknown): Promise<Response | null> {
  const key = pairKey(accountId(email.trim().toLowerCase()), req);
  const gate = await checkPair(key);
  if (!gate.ok) return verdictResponse(gate);
  const user = await getUserByEmail(email);
  const ok = typeof password === 'string' && password.length > 0 && password.length <= 1024
    && (await verifyPasswordOrDummy(password, user?.password_hash)) && Boolean(user) && !user?.disabled_at;
  if (!ok) {
    await recordFailure(key, accountId(email.trim().toLowerCase()));
    return Response.json({ ok: false, error: 'password is incorrect' }, { status: 403 });
  }
  await clearFailures(key);
  return null;
}
