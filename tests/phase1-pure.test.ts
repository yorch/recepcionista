/** Pure (database-free) tests for the phase-1 helpers: STIR attestation, KB patch validation, usage percent, type constants. */
import { describe, expect, test } from 'bun:test';
import { attestationLevel, cleanStirStatus, isCallerVerified } from '../src/lib/stir';
import { canonicalJson, kbFieldsChangedSince, kbValuesEqual, pickKbFields, validateKbPatch } from '../src/lib/kb-patch';
import { usagePercent } from '../src/lib/db/usage';
import { hashChallenge } from '../src/lib/db/passkeys';
import { BILLING_INTERVALS, LOCALES, REFUND_POLICIES, TRANSFER_STATUSES, VERTICALS } from '../src/lib/types';

describe('attestationLevel (STIR/SHAKEN verstat)', () => {
  const cases: [string | null | undefined, string][] = [
    ['TN-Validation-Passed-A', 'A'], ['TN-Validation-Passed-B', 'B'], ['TN-Validation-Passed-C', 'C'],
    ['tn-validation-passed-a', 'A'], ['  TN-Validation-Passed-B  ', 'B'],
    ['No-TN-Validation', 'none'], ['', 'none'], [null, 'none'], [undefined, 'none'], ['something-new', 'none'],
    ['TN-Validation-Passed-D', 'none'],
    ['TN-Validation-Failed-A', 'failed'], ['TN-Validation-Failed-C', 'failed'], ['TN-Validation-Failed', 'failed'],
  ];
  for (const [input, level] of cases) {
    test(`${JSON.stringify(input)} -> ${level}`, () => {
      expect(attestationLevel(input)).toBe(level);
    });
  }
  test('only attestation A counts as a verified caller', () => {
    expect(isCallerVerified('TN-Validation-Passed-A')).toBe(true);
    for (const s of ['TN-Validation-Passed-B', 'TN-Validation-Passed-C', 'No-TN-Validation', 'TN-Validation-Failed-A', null]) expect(isCallerVerified(s)).toBe(false);
  });
  test('cleanStirStatus keeps header-shaped values only', () => {
    expect(cleanStirStatus('TN-Validation-Passed-A')).toBe('TN-Validation-Passed-A');
    expect(cleanStirStatus('has space')).toBeNull();
    expect(cleanStirStatus('x'.repeat(65))).toBeNull();
    expect(cleanStirStatus('')).toBeNull();
  });
});

describe('validateKbPatch', () => {
  test('accepts a well-formed patch and normalises it', () => {
    const r = validateKbPatch({
      services: [{ name: ' AC repair ', base_price: 120, duration_minutes: 90 }],
      faqs: [{ question: ' Do you work Sundays? ', answer: 'No.' }],
      pricing_notes: 'Diagnostic $89',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.services?.[0].name).toBe('AC repair');
      expect(r.patch.faqs?.[0].question).toBe('Do you work Sundays?');
    }
  });
  test('rejects malformed patches', () => {
    const bad: unknown[] = [
      null, 'x', [], {}, { nope: 1 }, { services: 'x' }, { services: [{ name: '' }] }, { services: [{ name: 'a', base_price: -1 }] },
      { services: [{ name: 'a', duration_minutes: 2 }] }, { faqs: [{ question: 'q' }] }, { pricing_notes: 5 }, { system_prompt: 'x'.repeat(20_001) },
      { services: Array.from({ length: 201 }, () => ({ name: 'a' })) },
    ];
    for (const raw of bad) expect(validateKbPatch(raw).ok).toBe(false);
  });
});

describe('knowledge-base value comparison', () => {
  test('canonicalJson ignores key order (jsonb does not keep it)', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(canonicalJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
    expect(kbValuesEqual([{ name: 'a', base_price: 1 }], [{ base_price: 1, name: 'a' }])).toBe(true);
    expect(kbValuesEqual([{ name: 'a' }], [{ name: 'b' }])).toBe(false);
    expect(kbValuesEqual('x', 'y')).toBe(false);
  });
  const kb = { services: [{ name: 'a' }], faqs: [], pricing_notes: 'n', system_prompt: 'p', call_script: 'c' };
  test('pickKbFields / kbFieldsChangedSince', () => {
    expect(pickKbFields(kb, ['pricing_notes', 'bogus'])).toEqual({ pricing_notes: 'n' });
    expect(kbFieldsChangedSince(kb, { pricing_notes: 'n', services: [{ name: 'a' }] })).toEqual([]);
    expect(kbFieldsChangedSince(kb, { pricing_notes: 'other' })).toEqual(['pricing_notes']);
  });
});

describe('misc phase-1 constants and helpers', () => {
  test('usagePercent floors and handles a zero cap', () => {
    expect(usagePercent(79, 100)).toBe(79);
    expect(usagePercent(80, 100)).toBe(80);
    expect(usagePercent(399, 500)).toBe(79);
    expect(usagePercent(400, 500)).toBe(80);
    expect(usagePercent(1, 0)).toBe(100);
    expect(usagePercent(0, 0)).toBe(0);
  });
  test('challenge hashes are stable sha256 hex', () => {
    expect(hashChallenge('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChallenge('abc')).toBe(hashChallenge('abc'));
    expect(hashChallenge('abc')).not.toBe(hashChallenge('abd'));
  });
  test('enumerations match the database CHECK lists', () => {
    expect([...LOCALES]).toEqual(['en', 'es']);
    expect([...VERTICALS]).toEqual(['hvac', 'plumbing', 'electrical', 'cleaning', 'landscaping', 'dental', 'general']);
    expect([...REFUND_POLICIES]).toEqual(['none', 'full_24h', 'full_48h', 'full_always']);
    expect([...BILLING_INTERVALS]).toEqual(['month', 'year']);
    expect([...TRANSFER_STATUSES]).toEqual(['none', 'attempted', 'connected', 'failed', 'declined']);
  });
});
