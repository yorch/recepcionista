/**
 * Is this caller the business owner? Pure. The ONLY way a call enters owner mode: the platform/Twilio caller id equals the business's
 * VERIFIED owner number (E.164 equality; owner_phone_verified_at set). Caller id can be spoofed, so this alone grants nothing that is
 * not also confirmed by an SMS to the real owner phone (see code.ts / sms.ts). The model never decides this.
 */
import { phoneCountry, toE164 } from '@/lib/phone';
import { ownerCallinEnabled } from './config';
import type { Business } from '@/lib/types';

export type OwnerDetection =
  | { owner: true; e164: string }
  | { owner: false; reason: 'disabled' | 'no_owner_phone' | 'owner_unverified' | 'no_caller_id' | 'mismatch' | 'is_business_line' };

export function detectOwnerCaller(
  business: Pick<Business, 'owner_phone_e164' | 'owner_phone_verified_at' | 'phone_e164'>,
  callerId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): OwnerDetection {
  if (!ownerCallinEnabled(env)) return { owner: false, reason: 'disabled' };
  const owner = business.owner_phone_e164 ?? null;
  if (!owner) return { owner: false, reason: 'no_owner_phone' };
  if (!business.owner_phone_verified_at) return { owner: false, reason: 'owner_unverified' };
  const raw = typeof callerId === 'string' ? callerId.trim() : '';
  if (!raw || /[a-z]/i.test(raw)) return { owner: false, reason: 'no_caller_id' }; // "anonymous", "restricted", ...
  const caller = toE164(raw, phoneCountry(owner) ?? undefined);
  if (!caller) return { owner: false, reason: 'no_caller_id' };
  if (business.phone_e164 && caller === business.phone_e164) return { owner: false, reason: 'is_business_line' };
  return caller === owner ? { owner: true, e164: owner } : { owner: false, reason: 'mismatch' };
}
