/**
 * Outbound SMS compliance policy. Pure (no I/O) so it is unit-testable; `sendAndLog` feeds it
 * the facts (opt-out state, business timezone, "now") and obeys the decision.
 *
 * Audiences:
 *  - owner     : alerts to the business's own owner phone. Exempt from customer opt-out lists.
 *                SERVER-INTERNAL ONLY: no HTTP route accepts `kind`, so a tenant cannot label a free-text
 *                message `owner_alert` (and `owner_phone` cannot be pointed at a number that opted out).
 *  - customer  : transactional messages tied to a booking the customer asked for
 *                (confirmation, payment_link, or a reply to the caller). Blocked when opted out;
 *                always carry the STOP footer. `manual` (dashboard free text) is the same class but
 *                also obeys quiet hours, because nothing about it is time-critical or caller-initiated.
 *  - marketing : gratitude / review-request. Blocked when opted out, when no recorded consent
 *                basis exists, and during quiet hours (9pm-8am in the business timezone).
 */
import { partsInTz } from '@/lib/time';
import type { SmsLog } from '@/lib/types';

export type SmsClass = 'owner' | 'customer' | 'marketing';

export const STOP_FOOTER = 'Reply STOP to opt out';

/** Bases under which a marketing-type text may go out. Anything else is blocked. */
export const MARKETING_CONSENT_BASES = ['express_opt_in', 'booking_followup', 'customer_reply'] as const;

export const QUIET_START_HOUR = 21; // 9pm
export const QUIET_END_HOUR = 8; // 8am

const MARKETING_KINDS: ReadonlySet<SmsLog['kind']> = new Set(['gratitude', 'review_request']);

/** `isOwnerRecipient` must be true only when the destination is the business's own owner phone. */
export function classify(kind: SmsLog['kind'], isOwnerRecipient: boolean): SmsClass {
  if (kind === 'owner_alert' && isOwnerRecipient) return 'owner';
  if (MARKETING_KINDS.has(kind)) return 'marketing';
  return 'customer';
}

export function isQuietHour(now: Date, timezone: string): boolean {
  const h = partsInTz(now, timezone).hour;
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

export type BlockReason = 'blocked_opt_out' | 'blocked_quiet_hours' | 'blocked_no_consent';

export type Decision =
  | { allow: true; consent_basis: string; footer: boolean }
  | { allow: false; reason: BlockReason };

export interface PolicyInput {
  kind: SmsLog['kind'];
  isOwnerRecipient: boolean;
  optedOut: boolean;
  consentBasis?: string | null;
  timezone: string;
  now: Date;
}

export function decide(input: PolicyInput): Decision {
  const cls = classify(input.kind, input.isOwnerRecipient);
  if (cls === 'owner') return { allow: true, consent_basis: 'owner_alert', footer: false };
  if (input.optedOut) return { allow: false, reason: 'blocked_opt_out' };
  if (cls === 'customer') {
    if (input.kind === 'manual' && isQuietHour(input.now, input.timezone)) return { allow: false, reason: 'blocked_quiet_hours' };
    const basis = input.consentBasis?.trim()
      || (input.kind === 'other' ? 'caller_initiated' : input.kind === 'manual' ? 'owner_manual' : 'transactional_booking');
    return { allow: true, consent_basis: basis, footer: true };
  }
  // marketing
  const basis = input.consentBasis?.trim() ?? '';
  if (!(MARKETING_CONSENT_BASES as readonly string[]).includes(basis)) {
    return { allow: false, reason: 'blocked_no_consent' };
  }
  if (isQuietHour(input.now, input.timezone)) return { allow: false, reason: 'blocked_quiet_hours' };
  return { allow: true, consent_basis: basis, footer: true };
}

// ---- segment budgeting ------------------------------------------------------------------------

/** GSM 03.38 basic set + extension table (extension chars cost two septets). */
const GSM_BASIC = new Set(
  ['@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ', 'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?', '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§', '¿abcdefghijklmnopqrstuvwxyzäöñüà']
    .join('').split(''),
);
const GSM_EXT = new Set('^{}\\[~]|€'.split(''));

/** True when every character is in the GSM-7 alphabet (so the text is NOT forced to UCS-2). */
export function isGsm7(text: string): boolean {
  for (const ch of text) if (!GSM_BASIC.has(ch) && !GSM_EXT.has(ch)) return false;
  return true;
}

/** Number of SMS segments the text will occupy. */
export function smsSegments(text: string): number {
  if (!text) return 0;
  if (isGsm7(text)) {
    let septets = 0;
    for (const ch of text) septets += GSM_EXT.has(ch) ? 2 : 1;
    return septets <= 160 ? 1 : Math.ceil(septets / 153);
  }
  const units = text.length; // UTF-16 code units, which is what UCS-2 segments count
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

/** Only the exact footer counts as "already there" (free text like "text stop" must not suppress it). */
const FOOTER_RE = new RegExp(STOP_FOOTER.replace(/\s+/g, '\\s+'), 'i');

/**
 * Append the STOP notice to a customer-facing text. The BODY is trimmed (never the footer) so the
 * result stays within `limit` characters AND `maxSegments` SMS segments. Trimming is by code point (never
 * splits a surrogate pair) and marks the cut with ASCII "..." so a GSM-7 message stays GSM-7. Idempotent.
 */
export function withStopFooter(body: string, limit = 300, maxSegments = 5): string {
  if (FOOTER_RE.test(body)) return body;
  const tail = `. ${STOP_FOOTER}`;
  const base = body.replace(/\s+$/, '').replace(/[.!]$/, '');
  const fits = (t: string) => [...t].length + tail.length <= limit && smsSegments(t + tail) <= maxSegments;
  if (fits(base)) return `${base}${tail}`;
  const cps = [...base];
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) { // longest prefix that still fits together with "..." and the footer
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(`${cps.slice(0, mid).join('').trimEnd()}...`)) lo = mid; else hi = mid - 1;
  }
  return `${cps.slice(0, lo).join('').trimEnd()}...${tail}`;
}
