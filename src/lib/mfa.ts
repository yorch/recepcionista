/** Second-factor checks shared by the MFA login step and the security endpoints. Node runtime only. */
import { claimTotpStep, consumeRecoveryCode, getTotpState, getUserByEmail } from '@/lib/db';
import { accountId, checkPair, clearFailures, pairKey, peekPair, recordFailure, verdictResponse, type Verdict } from '@/lib/login-throttle';
import { afterResponse, sendMfaFailuresNotice } from '@/lib/account-flows';
import { recordAudit } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';
import { verifyPasswordOrDummy } from '@/lib/password';
import { decryptSecret, hashRecoveryCode, looksLikeRecoveryCode, verifyTotp } from '@/lib/totp';

/** A session that only passed the password step must finish the second factor within this long. */
export const MFA_PENDING_TTL_MS = 10 * 60_000;

export type SecondFactor =
  | { ok: true; method: 'totp' | 'recovery' }
  | { ok: false; locked?: Extract<Verdict, { ok: false }> };

/** Wrong second-factor attempts on ONE account (all addresses together) before the account's MFA step is emailed about. */
export const MFA_ACCOUNT_NOTICE_AFTER = 4;
/** Per-ACCOUNT throttle key for the second factor: independent of the client IP, so a botnet cannot fan out. */
export const mfaAccountKey = (userId: string): string => `auth/mfa:acct:${accountId(userId)}`;

export interface MfaAccountContext { email: string; businessId: string | null; ip: string | null }

/**
 * Verify a TOTP code (replay-guarded: the matched 30 s step is claimed atomically, so a code works once)
 * or, when `allowRecovery`, a single-use recovery code. Throws SecretKeyError/other when the stored secret
 * cannot be decrypted (callers answer 503): that is a server problem, not a wrong code.
 */
export async function verifySecondFactor(
  userId: string,
  input: { code?: unknown; recovery_code?: unknown },
  opts: { allowRecovery?: boolean; nowMs?: number; account?: MfaAccountContext } = {},
): Promise<SecondFactor> {
  // M5: per-ACCOUNT lock with exponential backoff, independent of the client address (the per-(user, IP) pair and
  // per-session limits cannot stop a distributed guesser). While locked nothing is checked, even a right code.
  const lock = await checkPair(mfaAccountKey(userId));
  if (!lock.ok) return { ok: false, locked: lock };
  const r = await verifyFactor(userId, input, opts);
  if (!r.ok) await onAccountFailure(userId, opts.account);
  return r;
}

const mfaLog = logger('mfa');

/** Count a wrong attempt against the account; from MFA_ACCOUNT_NOTICE_AFTER failures email the user (once an hour) and audit the lock. */
async function onAccountFailure(userId: string, account?: MfaAccountContext): Promise<void> {
  const key = mfaAccountKey(userId);
  await recordFailure(key, accountId(userId));
  const st = await peekPair(key);
  if (st.failures < MFA_ACCOUNT_NOTICE_AFTER) return;
  mfaLog.warn('account_mfa_guessing', { acct: accountId(userId).slice(0, 8), failures: st.failures, retry_after_s: st.retryAfterS });
  if (st.retryAfterS > 0) {
    await recordAudit({
      actor_kind: 'system', actor_user_id: userId, business_id: account?.businessId ?? null, action: 'auth.mfa_account_locked', target: `user:${userId}`, ip: account?.ip ?? null,
      meta: { failures: st.failures, retry_after_s: st.retryAfterS },
    });
  }
  if (account?.email && (await rateLimit(`auth/mfa:notice:${accountId(userId)}`, 1, 60 * 60_000)).allowed) {
    await afterResponse('mfa.failures_notice', () => sendMfaFailuresNotice(account.email));
  }
}

async function verifyFactor(
  userId: string,
  input: { code?: unknown; recovery_code?: unknown },
  opts: { allowRecovery?: boolean; nowMs?: number },
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
