/**
 * The "lead handled" marker id. A phone number must not be recoverable from a database dump, so the id is a KEYED hash (HMAC with a sub-key of
 * APP_SECRET_KEY, domain separated), not a bare SHA-256 of the number (about 10^10 candidates per country would be brute-forceable). It is bound to
 * the business and to the trust class of the call that marked it (a mark made on an unverified / possibly spoofed call hides the lead only from
 * unverified listings). eraseCustomerData deletes both ids for the erased number.
 */
import crypto from 'node:crypto';
import { appSecretKey } from '@/lib/totp';

export const HANDLED_SOURCE = 'owner-lead-handled';
export type HandledClass = 'v' | 'u';

const subKey = (key: Buffer): Buffer => crypto.createHmac('sha256', key).update('owner-lead-handled-v1').digest();

export function handledMarkerId(businessId: string, e164: string, cls: HandledClass, key: Buffer = appSecretKey()): string {
  return crypto.createHmac('sha256', subKey(key)).update(`${businessId}|${e164}|${cls}`).digest('hex').slice(0, 32);
}
