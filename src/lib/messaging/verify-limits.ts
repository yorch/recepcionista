/**
 * Abuse controls for owner-phone verification texts (the only SMS a not-yet-paying account can make the platform send
 * to an arbitrary number). Every limit is independent of the business, because businesses are cheap to mint:
 *
 *   per business+phone+client  5/h      per business  10/h and 15/day      per user  10/h      per client IP  20/h
 *   per destination number     3/h and 5/day, across ALL businesses         platform-wide  OWNER_VERIFY_GLOBAL_PER_HOUR (300/h)
 *                                                                           and OWNER_VERIFY_GLOBAL_PER_DAY (2000/day)
 *
 * Anti-pumping: refuse a number that opted out of ANY business on the platform, or that another business verified within
 * the last 30 days (admins may override that last rule). After the first FREE_VERIFY_TEXTS per business per day, and only
 * while billing is enforced, the plan cap applies like for any other text. The text itself is a fixed template
 * (ownerVerificationText): nothing a tenant typed is ever interpolated.
 * Node runtime only.
 */
import { configEnv } from '@/lib/config';
import { clientKey } from '@/lib/auth';
import { billingEnforced, checkSmsAllowed } from '@/lib/db/usage';
import { prisma } from '@/lib/db/client';
import { rateLimit } from '@/lib/ratelimit';

const HOUR = 60 * 60_000;
export const FREE_VERIFY_TEXTS = 3;
export const VERIFIED_ELSEWHERE_DAYS = 30;

const intEnv = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

export type VerifyStartDenial = { status: 422 | 429 | 402 | 503; error: string; retryAfterS?: number };

export interface VerifyStartInput {
  req: Request;
  businessId: string;
  e164: string;
  /** The signed-in user (null for the break-glass admin token). */
  userId: string | null;
  isAdmin: boolean;
  /** What is being verified (both share every cap: the platform-wide and per-number limits count both). */
  purpose?: 'owner-phone' | 'forward-number';
}

async function countSince(where: { toE164?: string; businessId?: string }, hours: number): Promise<number> {
  return prisma.smsLog.count({
    where: { consentBasis: 'owner_verification', createdAt: { gte: new Date(Date.now() - hours * HOUR) }, ...where },
  });
}

/** Returns a denial, or null when a verification text may be sent. Counts every attempt against the hourly buckets. */
export async function checkVerificationStart(i: VerifyStartInput): Promise<VerifyStartDenial | null> {
  const ip = clientKey(i.req);
  const ipLimit = ip === 'untrusted' ? 200 : 20; // without a trusted proxy every client shares one key
  const buckets: [string, number][] = [
    [`owner-phone/start:${i.businessId}:${i.e164}:${ip}`, 5],
    [`owner-phone/start:${i.businessId}:*`, 10],
    [`owner-phone/start:num:${i.e164}`, 3],
    [`owner-phone/start:ip:${ip}`, ipLimit],
    ...(i.userId ? [[`owner-phone/start:user:${i.userId}`, 10] as [string, number]] : []),
    ['owner-phone/start:global', intEnv(configEnv().OWNER_VERIFY_GLOBAL_PER_HOUR, 300)],
  ];
  for (const [key, limit] of buckets) {
    const r = await rateLimit(key, limit, HOUR, { failClosed: true });
    if (!r.allowed) {
      return r.error
        ? { status: 503, error: 'service temporarily unavailable', retryAfterS: r.retryAfterS }
        : { status: 429, error: 'too many verification texts; try again later', retryAfterS: r.retryAfterS };
    }
  }

  // Daily caps from the send log (survive bucket resets; cross-business for the destination and the platform).
  const [perNumber, perBusiness, global] = await Promise.all([
    countSince({ toE164: i.e164 }, 24),
    countSince({ businessId: i.businessId }, 24),
    countSince({}, 24),
  ]);
  if (perNumber >= 5) return { status: 429, error: 'too many verification texts to that number today', retryAfterS: 3600 };
  if (perBusiness >= 15) return { status: 429, error: 'too many verification texts today; try again tomorrow', retryAfterS: 3600 };
  if (global >= intEnv(configEnv().OWNER_VERIFY_GLOBAL_PER_DAY, 2000)) {
    return { status: 503, error: 'phone verification is temporarily unavailable', retryAfterS: 3600 };
  }

  // Anti-pumping: never text a number that said STOP to any tenant, nor one another business verified recently.
  if (await prisma.smsOptOut.findFirst({ where: { phoneE164: i.e164 }, select: { id: true } })) {
    return { status: 422, error: 'that number cannot be verified; contact support' };
  }
  if (!i.isAdmin) {
    const since = new Date(Date.now() - VERIFIED_ELSEWHERE_DAYS * 24 * HOUR);
    const elsewhere = await prisma.business.findFirst({
      where: {
        id: { not: i.businessId },
        OR: [
          { ownerPhoneE164: i.e164, ownerPhoneVerifiedAt: { gte: since } },
          { forwardNumberE164: i.e164, forwardNumberVerifiedAt: { gte: since } },
        ],
      },
      select: { id: true },
    });
    if (elsewhere) return { status: 422, error: 'that number is already verified for another account; contact support' };
  }

  // Count against the plan once the free allowance is used (only meaningful when billing is enforced).
  if (billingEnforced() && perBusiness >= FREE_VERIFY_TEXTS) {
    const allowed = await checkSmsAllowed(i.businessId);
    if (!allowed.ok) return { status: 402, error: 'your plan does not allow more texts right now' };
  }
  return null;
}
