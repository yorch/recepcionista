/**
 * The day-after loop. A happy customer is asked for a review; an unhappy one is
 * routed to the owner and never asked publicly. Finding candidates is read-only
 * so the sweep can be run repeatedly without double-texting anyone.
 */
import { sendGratitude } from '@/lib/messaging/actions';
import { logger } from '@/lib/log';
import { countryForBusiness, getBusiness, listBookings, listSms } from '@/lib/db';
import { defaultPhoneCountry, toE164 } from '@/lib/phone';
import type { Booking } from '@/lib/types';

const log = logger('gratitude');

const MIN_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function classifyReply(rating: number | string): 'review' | 'owner' {
  return Number(rating) >= 4 ? 'review' : 'owner';
}

/** Identity of a number for "already texted" bookkeeping: E.164 when valid, else the digits (never a last-10 collision). */
const idOf = (raw: string, country: string) => toE164(raw, country) ?? `raw:${raw.replace(/\D/g, '')}`;

/** Statuses that do not count as "already texted": the text never went out and may be retried by a later sweep. */
const RETRYABLE = new Set(['blocked_quiet_hours', 'blocked_cap']);

export async function findGratitudeCandidates(businessId?: string): Promise<Booking[]> {
  const now = Date.now();
  const country = businessId ? countryForBusiness(await getBusiness(businessId)) : undefined;
  const gratitudeSms = (await listSms(businessId)).filter((s) => s.kind === 'gratitude' && !RETRYABLE.has(s.status));
  const alreadyTexted = new Set(gratitudeSms.map((s) => `${s.business_id}|${idOf(s.to_phone, country ?? defaultPhoneCountry())}`));

  return (await listBookings(businessId)).filter((b) => {
    if (b.status !== 'completed') return false;
    const age = now - new Date(b.scheduled_at).getTime();
    if (age < MIN_AGE_MS || age > MAX_AGE_MS) return false;
    return !alreadyTexted.has(`${b.business_id}|${idOf(b.customer_phone, country ?? defaultPhoneCountry())}`);
  });
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
}

export async function runGratitudeSweep(businessId?: string): Promise<SweepResult> {
  const started = Date.now();
  const candidates = await findGratitudeCandidates(businessId);
  const ids: string[] = [];
  const r: SweepResult = {
    sent: 0, skipped: 0, ids, skipped_no_consent: 0, skipped_opt_out: 0, skipped_quiet_hours: 0, skipped_cap: 0, skipped_error: 0,
  };
  log.info('sweep.start', { business: businessId ?? 'all', candidates: candidates.length });

  for (const booking of candidates) {
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
