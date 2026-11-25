// Run with: bun test   (pure, no database).
import { describe, expect, test } from 'bun:test';
import {
  computeDepositCents, contentConfirmationState, contentFingerprint, DEFAULT_SCHEDULING, depositPolicyOf, schedulingOf,
  validateAssistantName, validateDepositPolicy, validateReviewUrl, validateSchedulingPatch, validateTimeZone, validateTwilioPhoneSid,
} from '../src/lib/business-config';
import { firstFreeCrew, hasFreeCrew, normalizeCrews } from '../src/lib/crews';

describe('validators', () => {
  test('review url: https only, <= 120, no spaces, clearable', () => {
    expect(validateReviewUrl('https://g.page/r/abc/review')).toEqual({ ok: true, value: 'https://g.page/r/abc/review' });
    expect(validateReviewUrl('  https://g.page/r/abc  ')).toEqual({ ok: true, value: 'https://g.page/r/abc' });
    expect(validateReviewUrl('')).toEqual({ ok: true, value: null });
    expect(validateReviewUrl(null)).toEqual({ ok: true, value: null });
    for (const bad of ['http://g.page/r/x', 'javascript:alert(1)', 'https://', 'https://localhost', 'https://a b.com/x', 'https://u:p@g.page/x', 'g.page/r/x', 5, `https://g.page/${'a'.repeat(120)}`]) {
      expect(validateReviewUrl(bad).ok).toBe(false);
    }
    expect(validateReviewUrl(`https://g.page/${'a'.repeat(105)}`).ok).toBe(true); // exactly 120
  });
  test('assistant name: 1-40 chars, trimmed, no control characters', () => {
    expect(validateAssistantName('  Sofia  ')).toEqual({ ok: true, value: 'Sofia' });
    expect(validateAssistantName('   ')).toEqual({ ok: true, value: null });
    expect(validateAssistantName('a'.repeat(40)).ok).toBe(true);
    expect(validateAssistantName('a'.repeat(41)).ok).toBe(false);
    expect(validateAssistantName('a\u0007b').ok).toBe(false);
    expect(validateAssistantName(12).ok).toBe(false);
  });
  test('time zone and provider ids', () => {
    expect(validateTimeZone('America/Chicago').ok).toBe(true);
    expect(validateTimeZone('EST').ok).toBe(false);
    expect(validateTwilioPhoneSid('PN' + 'a'.repeat(32))).toEqual({ ok: true, value: 'PN' + 'a'.repeat(32) });
    expect(validateTwilioPhoneSid('PN x').ok).toBe(false);
    expect(validateTwilioPhoneSid('P'.repeat(65)).ok).toBe(false);
  });
});

describe('deposit policy', () => {
  test('validation mirrors the CHECK constraints', () => {
    expect(validateDepositPolicy({ enabled: true, mode: 'fixed', fixed_cents: 5000 }).ok).toBe(true);
    expect(validateDepositPolicy({ enabled: true, mode: 'percent', percent: 25, min_cents: 2000, max_cents: 20000 }).ok).toBe(true);
    expect(validateDepositPolicy({}).ok).toBe(true); // disabled, nothing required
    const bad: unknown[] = [
      { enabled: true, mode: 'fixed' }, { enabled: true, mode: 'percent' }, { mode: 'weekly' },
      { enabled: true, mode: 'fixed', fixed_cents: 99 }, { enabled: true, mode: 'fixed', fixed_cents: 100_001 }, { enabled: true, mode: 'fixed', fixed_cents: 50.5 },
      { enabled: true, mode: 'percent', percent: 0 }, { enabled: true, mode: 'percent', percent: 101 }, { enabled: true, mode: 'percent', percent: 12.5 },
      { min_cents: 5000, max_cents: 4000 }, { min_cents: 50 }, { max_cents: 200_000 },
      { enabled: true, mode: 'fixed', fixed_cents: 1000, min_cents: 2000 }, { enabled: true, mode: 'fixed', fixed_cents: 9000, max_cents: 5000 },
      { enabled: 'yes' }, null, [], 'x',
    ];
    for (const b of bad) expect(validateDepositPolicy(b).ok).toBe(false);
  });
  test('computeDepositCents', () => {
    const fixed = depositPolicyOf({ deposit_enabled: true, deposit_mode: 'fixed', deposit_fixed_cents: 5000 });
    expect(computeDepositCents(fixed, null)).toBe(5000);
    expect(computeDepositCents(fixed, 123456)).toBe(5000);
    const pct = depositPolicyOf({ deposit_enabled: true, deposit_mode: 'percent', deposit_percent: 25, deposit_min_cents: 3000, deposit_max_cents: 20000 });
    expect(computeDepositCents(pct, 40000)).toBe(10000);
    expect(computeDepositCents(pct, 4000)).toBe(3000); // floor
    expect(computeDepositCents(pct, 1_000_000)).toBe(20000); // cap
    expect(computeDepositCents(pct, null)).toBeNull(); // no estimate, nothing to take a percent of
    expect(computeDepositCents(pct, 0)).toBeNull();
    const all = depositPolicyOf({ deposit_enabled: true, deposit_mode: 'percent', deposit_percent: 100 });
    expect(computeDepositCents(all, 2500)).toBe(2500);
    expect(computeDepositCents(all, 150)).toBe(150); // never more than the price
    expect(computeDepositCents(depositPolicyOf({ deposit_enabled: false, deposit_mode: 'fixed', deposit_fixed_cents: 5000 }), 1000)).toBeNull();
    expect(computeDepositCents(depositPolicyOf(null), 1000)).toBeNull();
  });
});

describe('scheduling', () => {
  test('defaults are the previous hard-coded behaviour', () => {
    expect(DEFAULT_SCHEDULING).toEqual({ slot_minutes: 60, min_lead_minutes: 60, horizon_days: 14, buffer_minutes: 0, crews: 1 });
    expect(schedulingOf(undefined)).toEqual(DEFAULT_SCHEDULING);
    expect(schedulingOf({ slot_minutes: 7 as never, crews: 99, horizon_days: 0 })).toEqual(DEFAULT_SCHEDULING);
    expect(schedulingOf({ slot_minutes: 30, crews: 3 })).toEqual({ ...DEFAULT_SCHEDULING, slot_minutes: 30, crews: 3 });
  });
  test('patch validation', () => {
    expect(validateSchedulingPatch({ slot_minutes: 15, crews: 20, buffer_minutes: 240, horizon_days: 180, min_lead_minutes: 0 }).ok).toBe(true);
    for (const b of [{ slot_minutes: 20 }, { crews: 0 }, { crews: 21 }, { buffer_minutes: 241 }, { horizon_days: 181 }, { min_lead_minutes: -1 }, { crews: 1.5 }, { nope: 1 }, null, []]) {
      expect(validateSchedulingPatch(b).ok).toBe(false);
    }
    expect(validateSchedulingPatch({ crews: undefined })).toEqual({ ok: true, value: {} });
  });
});

describe('crews', () => {
  const H = 3_600_000;
  const busy = [{ crew: 1, start: 0, end: H }, { crew: 2, start: 0, end: H }];
  test('first free crew, preference, exhaustion', () => {
    expect(firstFreeCrew(1, { start: 0, end: H }, [])).toBe(1);
    expect(firstFreeCrew(2, { start: 0, end: H }, [busy[0]])).toBe(2);
    expect(firstFreeCrew(3, { start: 0, end: H }, busy)).toBe(3);
    expect(firstFreeCrew(2, { start: 0, end: H }, busy)).toBeNull();
    expect(firstFreeCrew(3, { start: 0, end: H }, [busy[0]], 3)).toBe(3); // preferred and free
    expect(firstFreeCrew(3, { start: 0, end: H }, [busy[0]], 1)).toBe(2); // preferred busy -> first free
    expect(firstFreeCrew(2, { start: 0, end: H }, [], 5)).toBe(1); // preferred out of range is ignored
    expect(firstFreeCrew(1, { start: H, end: 2 * H }, busy)).toBe(1); // back to back does not overlap
    expect(hasFreeCrew(2, { start: H / 2, end: 2 * H }, busy)).toBe(false);
  });
  test('normalizeCrews', () => {
    expect([normalizeCrews(0), normalizeCrews(21), normalizeCrews('x'), normalizeCrews(4), normalizeCrews(2.9)]).toEqual([1, 1, 1, 4, 2]);
  });
});

describe('content confirmation fingerprint', () => {
  const kb = { services: [{ name: 'AC repair', base_price: 120 }, { name: 'Tune-up', base_price: 80, duration_minutes: 60 }], pricing_notes: 'Free estimates' };
  const biz = { service_area: ['Miami', 'Coral Gables'] };
  test('stable under order and case, sensitive to services / prices / area / pricing notes', () => {
    const base = contentFingerprint({ ...kb, service_area: biz.service_area });
    expect(contentFingerprint({ services: [...kb.services].reverse(), pricing_notes: ' Free estimates ', service_area: ['coral gables', 'MIAMI'] })).toBe(base);
    expect(contentFingerprint({ ...kb, services: [{ ...kb.services[0], base_price: 130 }, kb.services[1]], service_area: biz.service_area })).not.toBe(base);
    expect(contentFingerprint({ ...kb, service_area: ['Miami'] })).not.toBe(base);
    expect(contentFingerprint({ ...kb, pricing_notes: 'Estimates $50', service_area: biz.service_area })).not.toBe(base);
    expect(contentFingerprint({ ...kb, services: kb.services.slice(0, 1), service_area: biz.service_area })).not.toBe(base);
  });
  test('state', () => {
    const hash = contentFingerprint({ ...kb, service_area: biz.service_area });
    expect(contentConfirmationState({ content_confirmed_at: null, content_confirmed_hash: null, service_area: biz.service_area }, kb)).toBe('unconfirmed');
    expect(contentConfirmationState({ content_confirmed_at: '2026-12-01T00:00:00Z', content_confirmed_hash: hash, service_area: biz.service_area }, kb)).toBe('confirmed');
    expect(contentConfirmationState({ content_confirmed_at: '2026-12-01T00:00:00Z', content_confirmed_hash: hash, service_area: ['Orlando'] }, kb)).toBe('stale');
    expect(contentConfirmationState({ content_confirmed_at: '2026-12-01T00:00:00Z', content_confirmed_hash: hash, service_area: biz.service_area }, null)).toBe('stale');
  });
});
