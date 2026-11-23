/**
 * Outbound SMS compliance policy. Pure (no I/O) so it is unit-testable; `sendAndLog` feeds it
 * the facts (opt-out state, business timezone, "now") and obeys the decision.
 *
 * Audiences:
 *  - owner     : alerts to the business's own owner phone. Exempt from customer opt-out lists.
 *  - customer  : transactional messages tied to a booking the customer asked for
 *                (confirmation, payment_link, or a reply to the caller). Blocked when opted out;
 *                always carry the STOP footer.
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
    const basis = input.consentBasis?.trim()
      || (input.kind === 'other' ? 'caller_initiated' : 'transactional_booking');
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

/**
 * Append the STOP notice to a customer-facing text, staying within `limit` characters: if the
 * message is too long the BODY is trimmed (with an ellipsis), never the footer. Idempotent.
 */
export function withStopFooter(body: string, limit = 300): string {
  if (/reply\s+stop|responda\s+stop|text\s+stop/i.test(body)) return body;
  const tail = `. ${STOP_FOOTER}`;
  const base = body.replace(/\s+$/, '').replace(/[.!]$/, '');
  const room = limit - tail.length;
  const head = base.length <= room ? base : `${base.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${head}${tail}`;
}
