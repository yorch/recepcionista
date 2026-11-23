/**
 * Owner-phone trust. Owner alerts (emergency / handoff / payment / low-rating escalations) are exempt from customer
 * opt-outs and from SMS_ALLOWED_COUNTRY_CODES, so the destination must be a number the owner PROVED they control
 * (owner-phone verification, `businesses.owner_phone_verified_at`). Pure helpers, no I/O.
 */
import { toE164 } from '@/lib/phone';
import type { Business } from '@/lib/types';

/**
 * Rollout switch (default off). `OWNER_PHONE_GRANDFATHER=true` treats every existing `owner_phone` as verified
 * until its owner re-verifies, so a deploy does not silence alerts for businesses that predate verification.
 * Turn it off once owners have verified (see docs/runbook.md).
 */
export const ownerPhoneGrandfathered = (env: Record<string, string | undefined> = process.env): boolean => env.OWNER_PHONE_GRANDFATHER === 'true';

export type OwnerAlertStatus = 'ok' | 'no_owner_phone' | 'unverified';

export function ownerAlertStatus(
  b: Pick<Business, 'owner_phone' | 'owner_phone_verified_at'>,
  env: Record<string, string | undefined> = process.env,
): OwnerAlertStatus {
  if (!b.owner_phone) return 'no_owner_phone';
  return b.owner_phone_verified_at || ownerPhoneGrandfathered(env) ? 'ok' : 'unverified';
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
