/**
 * Per-business configuration added by the mock-replacement work: limits, validators (pure, no I/O) and the maths that use them.
 * The database CHECK constraints (migration 20261208120000) enforce the same limits; validators here give the friendly error first.
 * Every validator returns `{ ok: true, value }` or `{ ok: false, error }` and NEVER throws. See docs/design/mock-replacement-contracts.md.
 */
import { createHash } from 'node:crypto';
import { isIanaTimeZone } from './tz-infer';
import { normalizeCrews, MAX_CREWS, MIN_CREWS } from './crews';
import type { Business, DepositMode, KnowledgeBase } from './types';

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
const good = <T>(value: T): Validated<T> => ({ ok: true, value });
const bad = (error: string): Validated<never> => ({ ok: false, error });

// ---------------------------------------------------------------- limits
export const REVIEW_URL_MAX = 300;
export const ASSISTANT_NAME_MAX = 40;
/** Platform deposit limits, in integer cents (the same numbers as the CHECKs). The call script still caps AI-requested deposits lower. */
export const DEPOSIT_MIN_CENTS = 100;
export const DEPOSIT_MAX_CENTS = 100_000;
export const DEPOSIT_MODES: readonly DepositMode[] = ['fixed', 'percent'];
export const SLOT_MINUTES_CHOICES = [15, 30, 60] as const;
export const MIN_LEAD_MAX = 10_080; // one week
export const HORIZON_DAYS_MAX = 180;
export const BUFFER_MAX = 240;
export const INBOUND_BODY_MAX = 1600;
export const BRIEFING_AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const BRIEFING_AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg'] as const;

// ---------------------------------------------------------------- strings
/** Google review link: https only, no whitespace, at most 300 chars. `null` / empty clears it. */
export function validateReviewUrl(v: unknown): Validated<string | null> {
  if (v === null || v === undefined) return good(null);
  if (typeof v !== 'string') return bad('review_url must be a text');
  const s = v.trim();
  if (!s) return good(null);
  if (s.length > REVIEW_URL_MAX) return bad(`review_url must be at most ${REVIEW_URL_MAX} characters`);
  if (/\s/.test(s)) return bad('review_url must not contain spaces');
  let u: URL;
  try { u = new URL(s); } catch { return bad('review_url must be a valid https link'); }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return bad('review_url must be a valid https link');
  return good(s);
}

/** Assistant name: 1-40 chars after trimming; control characters and line breaks are refused. `null` / empty clears it. */
export function validateAssistantName(v: unknown): Validated<string | null> {
  if (v === null || v === undefined) return good(null);
  if (typeof v !== 'string') return bad('assistant_name must be a text');
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return good(null);
  if (s.length > ASSISTANT_NAME_MAX) return bad(`assistant_name must be at most ${ASSISTANT_NAME_MAX} characters`);
  if (/[\u0000-\u001f\u007f]/.test(s)) return bad('assistant_name must not contain control characters');
  return good(s);
}

/** Editable time zone: a real IANA name only (see isIanaTimeZone). */
export function validateTimeZone(v: unknown): Validated<string> {
  return isIanaTimeZone(v) ? good(v) : bad('timezone must be an IANA zone such as America/Chicago');
}

/** ElevenLabs phone-number id / Twilio phone sid: opaque tokens, 1..max chars, no whitespace. `null` / empty clears. */
export function validateProviderId(v: unknown, max: number, label: string): Validated<string | null> {
  if (v === null || v === undefined) return good(null);
  if (typeof v !== 'string') return bad(`${label} must be a text`);
  const s = v.trim();
  if (!s) return good(null);
  if (s.length > max || !/^[A-Za-z0-9_.:-]+$/.test(s)) return bad(`${label} is not a valid id`);
  return good(s);
}
export const validateElevenLabsPhoneNumberId = (v: unknown) => validateProviderId(v, 100, 'elevenlabs_phone_number_id');
export const validateTwilioPhoneSid = (v: unknown) => validateProviderId(v, 64, 'twilio_phone_sid');

// ---------------------------------------------------------------- deposit policy
export interface DepositPolicy {
  enabled: boolean;
  mode: DepositMode;
  fixed_cents: number | null;
  percent: number | null;
  min_cents: number | null;
  max_cents: number | null;
}

/** What a business without a policy looks like (the legacy behaviour: no automatic deposit). */
export const DEFAULT_DEPOSIT_POLICY: Readonly<DepositPolicy> = Object.freeze({ enabled: false, mode: 'fixed', fixed_cents: null, percent: null, min_cents: null, max_cents: null });

export function depositPolicyOf(b: Pick<Business, 'deposit_enabled' | 'deposit_mode' | 'deposit_fixed_cents' | 'deposit_percent' | 'deposit_min_cents' | 'deposit_max_cents'> | null | undefined): DepositPolicy {
  if (!b) return { ...DEFAULT_DEPOSIT_POLICY };
  return {
    enabled: b.deposit_enabled === true,
    mode: b.deposit_mode === 'percent' ? 'percent' : 'fixed',
    fixed_cents: b.deposit_fixed_cents ?? null,
    percent: b.deposit_percent ?? null,
    min_cents: b.deposit_min_cents ?? null,
    max_cents: b.deposit_max_cents ?? null,
  };
}

const centsIn = (v: unknown, label: string): Validated<number | null> => {
  if (v === null || v === undefined) return good(null);
  if (typeof v !== 'number' || !Number.isInteger(v)) return bad(`${label} must be a whole number of cents`);
  if (v < DEPOSIT_MIN_CENTS || v > DEPOSIT_MAX_CENTS) return bad(`${label} must be between ${DEPOSIT_MIN_CENTS} and ${DEPOSIT_MAX_CENTS} cents`);
  return good(v);
};

/** Validate a COMPLETE deposit policy (the same rules as the CHECK constraints, with readable errors). */
export function validateDepositPolicy(input: unknown): Validated<DepositPolicy> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('deposit policy must be an object');
  const p = input as Record<string, unknown>;
  const enabled = p.enabled === undefined ? false : p.enabled;
  if (typeof enabled !== 'boolean') return bad('enabled must be true or false');
  const mode = p.mode === undefined ? 'fixed' : p.mode;
  if (mode !== 'fixed' && mode !== 'percent') return bad('mode must be "fixed" or "percent"');
  const fixed = centsIn(p.fixed_cents, 'fixed_cents'); if (!fixed.ok) return fixed;
  const min = centsIn(p.min_cents, 'min_cents'); if (!min.ok) return min;
  const max = centsIn(p.max_cents, 'max_cents'); if (!max.ok) return max;
  let percent: number | null = null;
  if (p.percent !== null && p.percent !== undefined) {
    if (typeof p.percent !== 'number' || !Number.isInteger(p.percent) || p.percent < 1 || p.percent > 100) return bad('percent must be a whole number from 1 to 100');
    percent = p.percent;
  }
  if (min.value !== null && max.value !== null && min.value > max.value) return bad('min_cents must not exceed max_cents');
  if (fixed.value !== null && ((min.value !== null && fixed.value < min.value) || (max.value !== null && fixed.value > max.value))) return bad('fixed_cents must lie between min_cents and max_cents');
  if (enabled && mode === 'fixed' && fixed.value === null) return bad('fixed_cents is required for a fixed deposit');
  if (enabled && mode === 'percent' && percent === null) return bad('percent is required for a percentage deposit');
  return good({ enabled, mode, fixed_cents: fixed.value, percent, min_cents: min.value, max_cents: max.value });
}

/**
 * The deposit (integer cents) this policy asks for a job of `priceEstimateCents`. `null` = no deposit (policy off, or a percentage policy with no
 * usable estimate). Percentage deposits are clamped to [min_cents ?? 100, max_cents ?? 100000] and never exceed the price itself.
 */
export function computeDepositCents(policy: DepositPolicy, priceEstimateCents: number | null | undefined): number | null {
  if (!policy.enabled) return null;
  let cents: number | null;
  if (policy.mode === 'fixed') {
    cents = policy.fixed_cents;
  } else {
    if (policy.percent === null || priceEstimateCents == null || !Number.isFinite(priceEstimateCents) || priceEstimateCents <= 0) return null;
    cents = Math.round((priceEstimateCents * policy.percent) / 100);
    const lo = policy.min_cents ?? DEPOSIT_MIN_CENTS;
    const hi = policy.max_cents ?? DEPOSIT_MAX_CENTS;
    cents = Math.min(hi, Math.max(lo, cents));
    if (priceEstimateCents >= DEPOSIT_MIN_CENTS) cents = Math.min(cents, Math.round(priceEstimateCents)); // never more than the whole job
  }
  return cents !== null && cents >= DEPOSIT_MIN_CENTS && cents <= DEPOSIT_MAX_CENTS ? cents : null;
}

// ---------------------------------------------------------------- scheduling
export interface SchedulingConfig {
  slot_minutes: 15 | 30 | 60;
  min_lead_minutes: number;
  horizon_days: number;
  buffer_minutes: number;
  crews: number;
}

/** The values that reproduce the behaviour from before the configuration existed (hourly grid, 60 min lead for "next available", 14 days, no buffer, one crew). */
export const DEFAULT_SCHEDULING: Readonly<SchedulingConfig> = Object.freeze({ slot_minutes: 60, min_lead_minutes: 60, horizon_days: 14, buffer_minutes: 0, crews: 1 });

const intIn = (v: unknown, lo: number, hi: number, label: string): Validated<number> =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? good(v) : bad(`${label} must be a whole number from ${lo} to ${hi}`);

/** Validate a PARTIAL scheduling patch; unknown keys are an error. Returns only the keys that were given. */
export function validateSchedulingPatch(input: unknown): Validated<Partial<SchedulingConfig>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('scheduling must be an object');
  const out: Partial<SchedulingConfig> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue;
    let r: Validated<number>;
    switch (k) {
      case 'slot_minutes':
        if (!SLOT_MINUTES_CHOICES.includes(v as 15 | 30 | 60)) return bad('slot_minutes must be 15, 30 or 60');
        out.slot_minutes = v as 15 | 30 | 60; continue;
      case 'min_lead_minutes': r = intIn(v, 0, MIN_LEAD_MAX, k); if (!r.ok) return r; out.min_lead_minutes = r.value; continue;
      case 'horizon_days': r = intIn(v, 1, HORIZON_DAYS_MAX, k); if (!r.ok) return r; out.horizon_days = r.value; continue;
      case 'buffer_minutes': r = intIn(v, 0, BUFFER_MAX, k); if (!r.ok) return r; out.buffer_minutes = r.value; continue;
      case 'crews': r = intIn(v, MIN_CREWS, MAX_CREWS, k); if (!r.ok) return r; out.crews = r.value; continue;
      default: return bad(`unknown scheduling field "${k}"`);
    }
  }
  return good(out);
}

/** The effective scheduling configuration of a business (defaults for anything missing / invalid, e.g. a test double without the columns). */
export function schedulingOf(b: Partial<Pick<Business, 'slot_minutes' | 'min_lead_minutes' | 'horizon_days' | 'buffer_minutes' | 'crews'>> | null | undefined): SchedulingConfig {
  const pick = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return {
    slot_minutes: (SLOT_MINUTES_CHOICES.includes(b?.slot_minutes as 15 | 30 | 60) ? b?.slot_minutes : DEFAULT_SCHEDULING.slot_minutes) as 15 | 30 | 60,
    min_lead_minutes: pick(b?.min_lead_minutes, 0, MIN_LEAD_MAX, DEFAULT_SCHEDULING.min_lead_minutes),
    horizon_days: pick(b?.horizon_days, 1, HORIZON_DAYS_MAX, DEFAULT_SCHEDULING.horizon_days),
    buffer_minutes: pick(b?.buffer_minutes, 0, BUFFER_MAX, DEFAULT_SCHEDULING.buffer_minutes),
    crews: normalizeCrews(b?.crews),
  };
}

// ---------------------------------------------------------------- go-live content confirmation
/**
 * Fingerprint of what the owner confirms at go-live: the services (name, price, duration), the pricing notes and the service area.
 * Order-insensitive for services and areas; descriptions and FAQs do not count (editing prose does not invalidate a confirmation).
 */
export function contentFingerprint(input: { services?: ReadonlyArray<{ name?: string; base_price?: number | null; duration_minutes?: number }> | null; pricing_notes?: string | null; service_area?: readonly string[] | null }): string {
  const services = (input.services ?? [])
    .map((s) => [String(s.name ?? '').trim().toLowerCase(), s.base_price ?? null, s.duration_minutes ?? null] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const area = [...(input.service_area ?? [])].map((a) => String(a).trim().toLowerCase()).filter(Boolean).sort();
  const canonical = JSON.stringify({ s: services, p: String(input.pricing_notes ?? '').trim(), a: area });
  return createHash('sha256').update(canonical).digest('hex');
}

export type ContentConfirmation = 'unconfirmed' | 'confirmed' | 'stale';

/** unconfirmed (never confirmed) | confirmed (the confirmed fingerprint still matches) | stale (services / prices / service area changed since). */
export function contentConfirmationState(
  b: Pick<Business, 'content_confirmed_at' | 'content_confirmed_hash' | 'service_area'>,
  kb: Pick<KnowledgeBase, 'services' | 'pricing_notes'> | null | undefined,
): ContentConfirmation {
  if (!b.content_confirmed_at || !b.content_confirmed_hash) return 'unconfirmed';
  return contentFingerprint({ services: kb?.services, pricing_notes: kb?.pricing_notes, service_area: b.service_area }) === b.content_confirmed_hash ? 'confirmed' : 'stale';
}
