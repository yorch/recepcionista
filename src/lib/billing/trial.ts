/**
 * One free trial per person, not per business (L1). A new self-signup is a new business, so "one trial per business"
 * alone lets anyone collect unlimited trials (each with a real phone number and agent) with the same card or mailbox.
 *
 * Two fingerprints are remembered in `trial_fingerprints` (only hashes, never the raw value):
 *  - 'email': HMAC of the NORMALISED owner address (case, `+tag` and Gmail dots removed). Checked at checkout start:
 *    a seen address starts PAID (no trial).
 *  - 'card' : Stripe's card fingerprint, read when `checkout.session.completed` arrives. A card seen on another
 *    business ends the trial immediately (the first invoice is charged) and is audited.
 * Node runtime only.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { appSecretKey } from '@/lib/totp';

export type TrialKind = 'email' | 'card';

/** Case-insensitive, `+tag` removed, dots removed for Gmail/Googlemail (they are the same mailbox). */
export function normalizeEmailForTrial(email: string): string {
  const [localRaw, domainRaw = ''] = email.trim().toLowerCase().split('@');
  const domain = domainRaw === 'googlemail.com' ? 'gmail.com' : domainRaw;
  let local = localRaw.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

function fingerprint(kind: TrialKind, value: string): string {
  let key: Buffer;
  try { key = appSecretKey(); } catch { key = Buffer.from('recepcionista-trial-fingerprint'); }
  return crypto.createHmac('sha256', key).update(`trial/${kind}/${value}`).digest('hex');
}

export const emailFingerprint = (email: string): string => fingerprint('email', normalizeEmailForTrial(email));
export const cardFingerprint = (stripeFingerprint: string): string => fingerprint('card', stripeFingerprint);

/** Has this fingerprint already been used by ANOTHER business? (Pure read.) */
export async function trialUsedElsewhere(kind: TrialKind, fp: string, businessId: string): Promise<boolean> {
  const row = await prisma.trialFingerprint.findUnique({ where: { kind_fingerprint: { kind, fingerprint: fp } }, select: { businessId: true } });
  return Boolean(row && row.businessId !== businessId);
}

/**
 * Remember that `businessId` used its trial with this fingerprint. 'taken' = another business had it first (nothing is
 * written); 'own'/'fresh' = it belongs to this business.
 */
export async function claimTrial(kind: TrialKind, fp: string, businessId: string): Promise<'fresh' | 'own' | 'taken'> {
  // INSERT .. ON CONFLICT DO NOTHING: losing the race is a normal outcome, not an error.
  const res = await prisma.trialFingerprint.createMany({ data: [{ kind, fingerprint: fp, businessId }], skipDuplicates: true });
  if (res.count === 1) return 'fresh';
  return (await trialUsedElsewhere(kind, fp, businessId)) ? 'taken' : 'own';
}
