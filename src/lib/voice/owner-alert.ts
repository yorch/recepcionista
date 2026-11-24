/**
 * Owner alerts from the voice side (emergency, handoff, out-of-service notices). Honest by construction: `notified`
 * is true ONLY if the text really went out (or demo mode), and an alert is only attempted to a VERIFIED owner phone.
 */
import crypto from 'node:crypto';
import { claimEvent, completeEvent, prisma, releaseEvent } from '@/lib/db';
import { sendAndLog } from '@/lib/messaging';
import { ownerAlertStatus } from '@/lib/messaging/owner';
import { isGsm7 } from '@/lib/messaging/policy';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';
import type { Business, SmsLog } from '@/lib/types';

const log = logger('owner-alert');

export interface OwnerAlert {
  /** True ONLY if the SMS really went out (or demo mode mock), or an identical alert for this call already did. Never claim the owner was told otherwise. */
  notified: boolean;
  reason: 'sent' | 'no_owner_phone' | 'owner_unverified' | 'sms_failed' | 'sms_error' | 'rate_limited' | 'duplicate';
  sms: SmsLog | null;
}

/**
 * `emergency` / `handoff`: alerts a CALLER can trigger through a voice tool (cap-exempt, so they get their own hourly budget and
 * per-call dedupe). `notice`: platform-originated texts with their own limiter (missed-call alert, briefing-ready notice).
 */
export type OwnerAlertClass = 'emergency' | 'handoff' | 'notice';

/** Longest owner alert (characters AND GSM septets): 3 segments at most, whatever the caller said. */
export const OWNER_ALERT_MAX_CHARS = 320;
export const DEFAULT_OWNER_ALERT_HOURLY_LIMIT = 6;
const ALERT_WINDOW_MS = 60 * 60_000;
const DEDUPE_LEASE_MS = 10 * 60_000;
const FIRST_OF_CALL_LEASE_MS = 24 * 60 * 60_000;

/** OWNER_ALERT_HOURLY_LIMIT: emergency+handoff texts per business per hour (default 6, at least 1). */
export function ownerAlertHourlyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.OWNER_ALERT_HOURLY_LIMIT ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_OWNER_ALERT_HOURLY_LIMIT;
}

/** Hard ceiling of alerts per hour once first-of-call emergencies exceed the normal budget: 2x the budget (i.e. at most `limit` extra emergencies). */
export const emergencyCeiling = (limit: number): number => limit * 2;

const PUNCTUATION: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2212': '-', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2026': '...', '\u00a0': ' ', '\u2022': '*', '\t': ' ',
};
const septets = (ch: string): number => ('^{}\\[~]|\u20ac'.includes(ch) ? 2 : 1);

/**
 * Make an alert safe to send: GSM-7 only (so it stays at 1-3 cheap segments instead of flipping to 70-character UCS-2
 * segments because of one dash or accent), no control characters, whitespace collapsed, and at most `max` characters AND septets
 * (cut with "..." when longer). Accented letters fall back to their base letter; anything else (emoji...) becomes "?".
 */
export function clampAlertBody(body: string, max = OWNER_ALERT_MAX_CHARS): string {
  let out = '';
  for (const raw of Array.from(body ?? '')) {
    const ch = PUNCTUATION[raw] ?? raw;
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(ch)) continue; // keeps \n only
    if (isGsm7(ch)) { out += ch; continue; }
    const base = Array.from(ch.normalize('NFD'))[0] ?? '?'; // "a" for an accented a, the emoji itself otherwise
    out += base.length === 1 && isGsm7(base) ? base : '?';
  }
  out = out.replace(/[ ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/\?{2,}/g, '?').trim();
  let used = 0;
  let count = 0;
  for (const ch of out) { used += septets(ch); count++; }
  if (count <= max && used <= max) return out;
  const budget = max - 3;
  let res = '';
  let cost = 0;
  for (const ch of out) {
    if (cost + septets(ch) > budget) break;
    res += ch;
    cost += septets(ch);
  }
  return `${res.trimEnd()}...`;
}

/** A short single-line free-text field for an alert (what a caller said): clamped so one field cannot eat the whole message. */
export function alertField(value: string, max: number): string {
  const one = (value ?? '').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export interface AlertOptions {
  class?: OwnerAlertClass;
  /** The call this alert is about: identical alerts for one call are sent once, and the first emergency of a call is never starved. */
  callId?: string | null;
}

async function claimStatus(source: string, id: string): Promise<string | null> {
  const row = await prisma.processedEvent.findUnique({ where: { source_id: { source, id } }, select: { status: true } });
  return row?.status ?? null;
}

export async function alertOwner(business: Business, body: string, opts: AlertOptions = {}): Promise<OwnerAlert> {
  const status = ownerAlertStatus(business);
  if (status === 'no_owner_phone') {
    log.error('owner_alert.no_owner_phone', { business: business.id });
    return { notified: false, reason: 'no_owner_phone', sms: null };
  }
  if (status === 'unverified') {
    log.error('owner_alert.owner_unverified', { business: business.id, action: 'owner must verify their phone (Settings)' });
    return { notified: false, reason: 'owner_unverified', sms: null };
  }
  const text = clampAlertBody(body);
  const klass = opts.class ?? 'notice';
  const callerTriggered = klass !== 'notice';
  const dedupeId = `${opts.callId ?? `business:${business.id}`}:${klass}:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
  const firstId = opts.callId ? `${opts.callId}:${klass}` : null;
  let claimedDedupe = false;
  let claimedFirst = false;
  const giveBack = async () => {
    if (claimedDedupe) await releaseEvent('owner-alert', dedupeId);
    if (claimedFirst && firstId) await releaseEvent('owner-alert-first', firstId);
  };
  try {
    if (callerTriggered) {
      // Identical alert for the same call: sent once. (An earlier delivered one means the owner IS told; an in-flight one is not yet confirmed.)
      claimedDedupe = await claimEvent('owner-alert', dedupeId, DEDUPE_LEASE_MS);
      if (!claimedDedupe) {
        const state = await claimStatus('owner-alert', dedupeId);
        log.warn('owner_alert.duplicate', { business: business.id, class: klass, state });
        return { notified: state === 'done', reason: state === 'done' ? 'sent' : 'duplicate', sms: null };
      }
      claimedFirst = firstId ? await claimEvent('owner-alert-first', firstId, FIRST_OF_CALL_LEASE_MS) : false;
      const limit = ownerAlertHourlyLimit();
      const hour = await rateLimit(`owner-alert:hour:${business.id}`, limit, ALERT_WINDOW_MS, { failClosed: true });
      if (!hour.allowed) {
        // Budget spent. The FIRST emergency of a call still goes out (life safety), up to a hard ceiling; everything else waits.
        const mayExceed = klass === 'emergency' && claimedFirst
          && (await rateLimit(`owner-alert:extra:${business.id}`, emergencyCeiling(limit) - limit, ALERT_WINDOW_MS)).allowed;
        if (!mayExceed) {
          log.error('owner_alert.rate_limited', { business: business.id, class: klass, limit_per_hour: limit });
          await giveBack();
          return { notified: false, reason: 'rate_limited', sms: null };
        }
        log.warn('owner_alert.budget_exceeded_first_emergency', { business: business.id, limit_per_hour: limit });
      }
    }
    const { sms, result: sent, blocked } = await sendAndLog({
      business_id: business.id, to: business.owner_phone as string, body: text, kind: 'owner_alert',
    });
    if (blocked) {
      log.error('owner_alert.blocked', { business: business.id, blocked });
      await giveBack();
      return { notified: false, reason: blocked === 'blocked_owner_unverified' ? 'owner_unverified' : 'sms_failed', sms };
    }
    // 'mock' means no Twilio configured: only counts as delivered in explicit demo mode.
    const delivered = sent.status === 'sent' || (sent.status === 'mock' && process.env.DEMO_MODE === 'true');
    if (!delivered) {
      log.error('owner_alert.not_delivered', { business: business.id, status: sent.status, error: sent.error ?? null });
      await giveBack();
    } else if (claimedDedupe) {
      await completeEvent('owner-alert', dedupeId);
    }
    return { notified: delivered, reason: delivered ? 'sent' : 'sms_failed', sms };
  } catch (err) {
    log.error('owner_alert.error', { business: business.id, err });
    await giveBack();
    return { notified: false, reason: 'sms_error', sms: null };
  }
}
