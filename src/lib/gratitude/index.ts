/**
 * The day-after loop. A happy customer is asked for a review; an unhappy one is
 * routed to the owner and never asked publicly. Finding candidates is read-only
 * so the sweep can be run repeatedly without double-texting anyone.
 */
import { appUrl } from '@/lib/providers/stripe';
import { listBookings, listSms } from '@/lib/db';
import type { Booking } from '@/lib/types';

const MIN_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function classifyReply(rating: number | string): 'review' | 'owner' {
  return Number(rating) >= 4 ? 'review' : 'owner';
}

export function findGratitudeCandidates(businessId?: string): Booking[] {
  const now = Date.now();
  const gratitudeSms = listSms(businessId).filter((s) => s.kind === 'gratitude');
  const alreadyTexted = new Set(
    gratitudeSms.map((s) => s.to_phone.replace(/\D/g, '').slice(-10)),
  );

  return listBookings(businessId).filter((b) => {
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
  const candidates = findGratitudeCandidates(businessId);
  const ids: string[] = [];
  let skipped = 0;

  for (const booking of candidates) {
    try {
      const res = await fetch(`${appUrl()}/api/sms/gratitude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          booking_id: booking.id,
          language: 'en',
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        skipped++;
        continue;
      }
      const json = await res.json();
      if (json?.ok) ids.push(booking.id);
      else skipped++;
    } catch {
      skipped++;
    }
  }

  return { sent: ids.length, skipped, ids };
}
