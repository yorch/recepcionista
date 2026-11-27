/**
 * Owner call-in settings. The owner phones the business line and talks to a private assistant that updates the AI's knowledge; every
 * change is applied only after a second channel (an SMS to the verified owner phone) confirms it. See docs/owner-call-in.md.
 */

import { configEnv } from '@/lib/config';
/** OWNER_CALLIN_ENABLED (default true): set to "false" to turn the whole feature off (owner calls then behave like any caller). */
export const ownerCallinEnabled = (env: Record<string, string | undefined> = configEnv()): boolean => (env.OWNER_CALLIN_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

export const OWNER_CALL_MAX_SECONDS_DEFAULT = 300;
/** OWNER_CALL_MAX_SECONDS: hard length of an owner session, 30..300 (never longer than 5 minutes). */
export function ownerCallMaxSeconds(env: Record<string, string | undefined> = configEnv()): number {
  const n = Number((env.OWNER_CALL_MAX_SECONDS ?? '').trim());
  return Number.isInteger(n) && n >= 30 ? Math.min(n, OWNER_CALL_MAX_SECONDS_DEFAULT) : OWNER_CALL_MAX_SECONDS_DEFAULT;
}

export const OWNER_SESSIONS_PER_DAY = 10;
export const OWNER_PROPOSALS_PER_CALL = 5;
export const OWNER_CONFIRM_SMS_PER_HOUR = 6;
/** A confirmation code works for this long after the change was proposed (YES / NO) or applied (UNDO). */
export const OWNER_CODE_TTL_MS = 30 * 60_000;
/** Rejected / attack-looking proposals within an hour before the owner line locks. */
export const OWNER_BAD_PROPOSALS_LOCKOUT = 5;
export const OWNER_LOCKOUT_MS = 60 * 60_000;
/** Wrong or expired codes texted in 15 minutes before the SMS commands stop answering. */
export const OWNER_BAD_CODES_LOCKOUT = 5;
/** A read-back preview is good for this long (the owner must say yes within it). */
export const OWNER_PREVIEW_TTL_MS = 10 * 60_000;

/**
 * Budgets are kept per CALLER-IDENTITY CLASS, not only per business (reports 11 L4, 12 L6). A call whose number carries STIR/SHAKEN
 * attestation A is `verified`: the originating carrier vouches for the number, so it cannot be a spoof of the owner's number. Every other
 * call (no verdict, B, C) is `unverified`: its caller id is spoofable. The two classes have SEPARATE session counts, proposal lockouts
 * and confirmation-text budgets, so a spoofer who exhausts the unverified budget cannot touch the budget of an A-attested owner call.
 * (A failed verdict never gets here: it is served as a stranger.) A real owner whose carrier gives no verdict shares the unverified
 * budget with a spoofer; the dashboard is the fallback for them (docs/owner-call-in.md).
 */
export type OwnerTrust = 'verified' | 'unverified';
export const ownerTrustOf = (call: { caller_verified?: boolean | null } | null | undefined): OwnerTrust => (call?.caller_verified === true ? 'verified' : 'unverified');
/** The key a per-class budget (lockout, confirmation texts, strikes) is stored under. */
export const ownerBudgetId = (businessId: string, trust: OwnerTrust): string => `${businessId}:${trust === 'verified' ? 'v' : 'u'}`;
