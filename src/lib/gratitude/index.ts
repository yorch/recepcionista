/**
 * The day-after loop. A happy customer is asked for a review; an unhappy one is
 * routed to the owner and never asked publicly. Finding candidates is read-only
 * so the sweep can be run repeatedly without double-texting anyone.
 */
import { sendGratitude } from '@/lib/messaging/actions';
import { logger } from '@/lib/log';
import { countryForBusiness, getBusiness, listBookingsStartedBetween, listGratitudeSmsTo } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import type { Booking } from '@/lib/types';

const log = logger('gratitude');

const MIN_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function classifyReply(rating: number | string): 'review' | 'owner' {
  return Number(rating) >= 4 ? 'review' : 'owner';
}

/** Identity of a number for "already texted" bookkeeping: E.164 when valid, else the digits (never a last-10 collision). */
const idOf = (raw: string, country: string) => toE164(raw, country) ?? `raw:${raw.replace(/\D/g, '')}`;

export async function findGratitudeCandidates(businessId?: string): Promise<Booking[]> {
  const now = Date.now();
  // Only completed jobs that started 20-48 hours ago can qualify: one ranged query, never the whole history.
  const window = await listBookingsStartedBetween({
    businessId, status: 'completed', from: new Date(now - MAX_AGE_MS), to: new Date(now - MIN_AGE_MS),
  });
  if (window.length === 0) return [];

  // "Already texted" bookkeeping per (business, number): only the numbers of these few candidates are looked up.
  const byBusiness = new Map<string, Booking[]>();
  for (const b of window) byBusiness.set(b.business_id, [...(byBusiness.get(b.business_id) ?? []), b]);
  const out: Booking[] = [];
  for (const [bid, bookings] of byBusiness) {
    const country = countryForBusiness(await getBusiness(bid));
    const sent = await listGratitudeSmsTo(bid, bookings.map((b) => b.customer_phone), country);
    const alreadyTexted = new Set(sent.map((s) => idOf(s.to_phone, country)));
    for (const b of bookings) if (!alreadyTexted.has(idOf(b.customer_phone, country))) out.push(b);
  }
  return out;
}

export interface SweepResult {
  sent: number;
  /** Everything not sent (the breakdown below says why). */
  skipped: number;
  ids: string[];
  /**
   * Why bookings were skipped. `no_consent`: no follow-up consent was ever recorded for that booking (bookings made
   * before consent capture existed, or whose confirmation text was never delivered): by design they are never
   * texted, and nothing is logged or sent for them.
   */
  skipped_no_consent: number;
  skipped_opt_out: number;
  skipped_quiet_hours: number;
  skipped_cap: number;
  skipped_error: number;
  /** The job lease was lost mid-sweep: the sweep stopped early without sending the rest. */
  aborted?: boolean;
}

/**
 * `signal` (the job runner's lease signal): once it aborts the lease is lost and a successor may be sweeping, so no further text
 * is sent (`aborted` is set on the result; the unsent bookings are picked up by the next sweep).
 */
export async function runGratitudeSweep(businessId?: string, opts: { signal?: AbortSignal } = {}): Promise<SweepResult> {
  const started = Date.now();
  const candidates = await findGratitudeCandidates(businessId);
  const ids: string[] = [];
  const r: SweepResult = {
    sent: 0, skipped: 0, ids, skipped_no_consent: 0, skipped_opt_out: 0, skipped_quiet_hours: 0, skipped_cap: 0, skipped_error: 0,
  };
  const aborted = () => opts.signal?.aborted === true;
  log.info('sweep.start', { business: businessId ?? 'all', candidates: candidates.length });

  for (const booking of candidates) {
    if (aborted()) { r.aborted = true; break; } // lease lost: stop before the next text
    // No recorded consent: do not even attempt (no blocked row per sweep); the owner sees the count.
    if (!booking.followup_consent_at) { r.skipped++; r.skipped_no_consent++; continue; }
    try {
      const { sms } = await sendGratitude(booking.id, 'en');
      if (sms.status.startsWith('blocked')) {
        r.skipped++;
        if (sms.status === 'blocked_opt_out') r.skipped_opt_out++;
        else if (sms.status === 'blocked_quiet_hours') r.skipped_quiet_hours++;
        else if (sms.status === 'blocked_cap') r.skipped_cap++;
        else if (sms.status === 'blocked_no_consent') r.skipped_no_consent++;
        else r.skipped_error++;
        continue; // quiet hours / cap are retried by the next sweep; opt-outs are not
      }
      ids.push(booking.id);
    } catch (err) {
      log.warn('sweep.error', { booking: booking.id, err });
      r.skipped++;
      r.skipped_error++;
    }
  }
  r.sent = ids.length;

  log.info('sweep.done', { business: businessId ?? 'all', ...r, ids: undefined, ms: Date.now() - started });
  return r;
}
