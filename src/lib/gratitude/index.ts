/**
 * The day-after loop. A happy customer is asked for a review; an unhappy one is
 * routed to the owner and never asked publicly. Finding candidates is read-only
 * so the sweep can be run repeatedly without double-texting anyone.
 */
import { sendGratitude } from '@/lib/messaging/actions';
import { logger } from '@/lib/log';
import { listBookings, listSms } from '@/lib/db';
import type { Booking } from '@/lib/types';

const log = logger('gratitude');

const MIN_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function classifyReply(rating: number | string): 'review' | 'owner' {
  return Number(rating) >= 4 ? 'review' : 'owner';
}

export async function findGratitudeCandidates(businessId?: string): Promise<Booking[]> {
  const now = Date.now();
  const gratitudeSms = (await listSms(businessId)).filter((s) => s.kind === 'gratitude');
  const alreadyTexted = new Set(
    gratitudeSms.map((s) => s.to_phone.replace(/\D/g, '').slice(-10)),
  );

  return (await listBookings(businessId)).filter((b) => {
    if (b.status !== 'completed') return false;
    const age = now - new Date(b.scheduled_at).getTime();
    if (age < MIN_AGE_MS || age > MAX_AGE_MS) return false;
    return !alreadyTexted.has(b.customer_phone.replace(/\D/g, '').slice(-10));
  });
}

export interface SweepResult {
  sent: number;
  skipped: number;
  ids: string[];
}

export async function runGratitudeSweep(businessId?: string): Promise<SweepResult> {
  const started = Date.now();
  const candidates = await findGratitudeCandidates(businessId);
  const ids: string[] = [];
  let skipped = 0;
  log.info('sweep.start', { business: businessId ?? 'all', candidates: candidates.length });

  for (const booking of candidates) {
    try {
      await sendGratitude(booking.id, 'en');
      ids.push(booking.id);
    } catch (err) {
      log.warn('sweep.error', { booking: booking.id, err });
      skipped++;
    }
  }

  log.info('sweep.done', {
    business: businessId ?? 'all',
    sent: ids.length,
    skipped,
    ms: Date.now() - started,
  });
  return { sent: ids.length, skipped, ids };
}
