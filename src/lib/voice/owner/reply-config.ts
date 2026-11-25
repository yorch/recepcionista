/**
 * Owner VOICE REPLY settings ("owner calls back, the assistant relays by text"). Kept apart from config.ts on purpose. See docs/owner-call-in.md "Voice reply".
 */
import { ownerCallinEnabled } from './config';

/** OWNER_REPLY_ENABLED: defaults to whatever OWNER_CALLIN_ENABLED says (the reply channel needs the owner line); "false" turns only replies off. */
export function ownerReplyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (!ownerCallinEnabled(env)) return false;
  const raw = (env.OWNER_REPLY_ENABLED ?? '').trim().toLowerCase();
  return raw === '' ? true : raw !== 'false';
}

/** OWNER_REPLY_DAILY_LIMIT: texts to customers sent through the owner line per business per rolling 24 h (default 10, 1..100). Drafts are budgeted at the same number per identity class. */
export function ownerReplyDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env.OWNER_REPLY_DAILY_LIMIT ?? '').trim());
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 100) : 10;
}

/** OWNER_REPLY_REQUIRE_ATTESTATION=true: lead tools and replies work only on a call the carrier vouched for (STIR/SHAKEN attestation A). Default off. */
export const ownerReplyRequiresAttestation = (env: Record<string, string | undefined> = process.env): boolean => (env.OWNER_REPLY_REQUIRE_ATTESTATION ?? '').trim().toLowerCase() === 'true';

/** Longest message the owner can relay (characters). The owner's confirmation text must show it in full (it is 1-2 segments). */
export const OWNER_REPLY_MAX_CHARS = 120;
/** A customer text may not exceed this many SMS segments (prefix + message + STOP footer). */
export const OWNER_REPLY_MAX_SEGMENTS = 4;
/** A confirmation code works for this long after the draft (YES / NO). Same 30 minutes as the knowledge-change codes. */
export const OWNER_REPLY_TTL_MS = 30 * 60_000;
/** How far back a call or booking is still a lead the owner can reply to. */
export const OWNER_REPLY_LEAD_WINDOW_MS = 7 * 24 * 3600_000;
/** Leads read out per request. */
export const OWNER_REPLY_LEADS_SHOWN = 5;
/** Drafts per owner call. */
export const OWNER_REPLY_DRAFTS_PER_CALL = 5;
/** Texts to one customer per hour (sent; by the rate limiter). */
export const OWNER_REPLY_PER_CUSTOMER_HOUR = 2;
/** Lead lists per owner call per hour (a caller cannot page through every customer). */
export const OWNER_REPLY_LISTS_PER_HOUR = 6;
/**
 * Distinct leads the owner line may DISCLOSE per business per rolling 24 h, per trust class (verified = STIR A, unverified = anything else, including a
 * spoofed caller id). A lead already disclosed in the window can be listed again for free; a new one counts. Marking a lead handled cannot widen this
 * (only a listed lead can be marked), so a spoofed caller sees at most this many distinct leads a day, newest first.
 */
export const OWNER_REPLY_DISCLOSED_PER_DAY = { verified: 30, unverified: 10 } as const;
/** Leads that may be marked handled per business per rolling 24 h, per trust class. */
export const OWNER_REPLY_HANDLED_PER_DAY = { verified: 30, unverified: 5 } as const;
/** Leads one owner call may mark handled. */
export const OWNER_REPLY_HANDLED_PER_CALL = 3;
