/**
 * Owner-phone trust. Owner alerts (emergency / handoff / payment / low-rating escalations) are exempt from customer
 * opt-outs and from SMS_ALLOWED_COUNTRY_CODES, so the destination must be a number the owner PROVED they control
 * (owner-phone verification, `businesses.owner_phone_verified_at`). Pure helpers, no I/O.
 */
import { toE164 } from '@/lib/phone';
import type { Business } from '@/lib/types';

/** Required in production for OWNER_PHONE_GRANDFATHER=true to have any effect (see ownerPhoneGrandfathered). */
export const OWNER_PHONE_GRANDFATHER_ACK_VALUE = 'i-understand';

/**
 * Rollout switch (default off). `OWNER_PHONE_GRANDFATHER=true` treats an existing `owner_phone` as verified until its
 * owner re-verifies, so a deploy does not silence alerts for businesses that predate verification. It is DANGEROUS:
 * a grandfathered number is exempt from opt-outs and from the country allow-list, and it was never proven to belong
 * to the owner. Hence:
 *  - in production it is IGNORED unless `OWNER_PHONE_GRANDFATHER_ACK=i-understand` is also set (startup logs a warning
 *    either way, see ownerPhoneGrandfatherProblem);
 *  - `OWNER_PHONE_GRANDFATHER_UNTIL=<ISO date>` time-boxes it (ignored after that instant);
 *  - `OWNER_PHONE_GRANDFATHER_BEFORE=<ISO date>` limits it to businesses created before that instant (set it to the
 *    deploy time so nobody who signs up afterwards benefits).
 * Turn it off once owners have verified (docs/runbook.md).
 */
export const ownerPhoneGrandfathered = (
  env: Record<string, string | undefined> = process.env,
  business?: { created_at?: string | null },
  now: number = Date.now(),
): boolean => {
  if (env.OWNER_PHONE_GRANDFATHER !== 'true') return false;
  if (env.NODE_ENV === 'production' && env.OWNER_PHONE_GRANDFATHER_ACK !== OWNER_PHONE_GRANDFATHER_ACK_VALUE) return false;
  const until = env.OWNER_PHONE_GRANDFATHER_UNTIL ? Date.parse(env.OWNER_PHONE_GRANDFATHER_UNTIL) : NaN;
  if (env.OWNER_PHONE_GRANDFATHER_UNTIL && (!Number.isFinite(until) || now >= until)) return false; // unparseable: fail closed
  const before = env.OWNER_PHONE_GRANDFATHER_BEFORE ? Date.parse(env.OWNER_PHONE_GRANDFATHER_BEFORE) : NaN;
  if (env.OWNER_PHONE_GRANDFATHER_BEFORE) {
    if (!Number.isFinite(before)) return false;
    const created = business?.created_at ? Date.parse(business.created_at) : NaN;
    if (!Number.isFinite(created) || created >= before) return false;
  }
  return true;
};

/** Startup diagnostics for OWNER_PHONE_GRANDFATHER (null when it is off). */
export function ownerPhoneGrandfatherProblem(env: Record<string, string | undefined> = process.env): string | null {
  if (env.OWNER_PHONE_GRANDFATHER !== 'true') return null;
  if (env.NODE_ENV === 'production' && env.OWNER_PHONE_GRANDFATHER_ACK !== OWNER_PHONE_GRANDFATHER_ACK_VALUE) {
    return 'OWNER_PHONE_GRANDFATHER=true is IGNORED in production without OWNER_PHONE_GRANDFATHER_ACK=i-understand: unverified owner phones will not receive alerts';
  }
  return 'OWNER_PHONE_GRANDFATHER is ON: unverified owner phones receive alerts that bypass opt-outs and the country allow-list; '
    + (env.OWNER_PHONE_GRANDFATHER_UNTIL || env.OWNER_PHONE_GRANDFATHER_BEFORE ? 'time-boxed/cutoff configured' : 'set OWNER_PHONE_GRANDFATHER_UNTIL and OWNER_PHONE_GRANDFATHER_BEFORE and turn it off as soon as owners have verified');
}

export type OwnerAlertStatus = 'ok' | 'no_owner_phone' | 'unverified';

export function ownerAlertStatus(
  b: Pick<Business, 'owner_phone' | 'owner_phone_verified_at'> & { created_at?: string | null },
  env: Record<string, string | undefined> = process.env,
): OwnerAlertStatus {
  if (!b.owner_phone) return 'no_owner_phone';
  return b.owner_phone_verified_at || ownerPhoneGrandfathered(env, b) ? 'ok' : 'unverified';
}

/** True when `to` is the business's own owner phone (compared as E.164, never by trailing digits). */
export function isOwnerNumber(
  b: Pick<Business, 'owner_phone' | 'owner_phone_e164' | 'phone_e164'>,
  to: string,
  country: string,
): boolean {
  const target = toE164(to, country);
  const owner = b.owner_phone_e164 ?? toE164(b.owner_phone, country);
  return Boolean(target) && Boolean(owner) && target === owner;
}
