import { describe, expect, test } from 'bun:test';
import { makeT } from '../src/lib/i18n';
import { forwardingGuide, prettyPhone, tenDigits } from '../src/app/onboarding/forwarding';
import { maxStepFor, resolveStep } from '../src/app/onboarding/steps';
import type { OnboardingStatus } from '../src/app/api/businesses/[id]/onboarding-status/status';
import { nextStep } from '../src/app/api/businesses/[id]/onboarding-status/status';
import {
  draftFromExtraction, draftFromServer, mergeExtraction, parsePrice, snapshot, toKnowledgePayload, validateDraft, hasErrors,
} from '../src/components/knowledge/model';
import type { ExtractionResult } from '../src/lib/types';

const ex: ExtractionResult = {
  name: 'Acme', confidence: 'high', source: 'scrape', pricing_notes: 'Fee waived',
  service_area: ['Miami', 'Doral'],
  hours: { monday: { open: '08:00', close: '17:00' }, tuesday: null },
  services: [{ name: 'AC repair', base_price: 150, duration_minutes: 90 }, { name: 'Tune-up', base_price: 89 }],
  faqs: [{ question: 'Do you offer financing?', answer: 'Yes' }],
};

describe('forwarding guide', () => {
  test('GSM codes embed the E.164 number', () => {
    const g = forwardingGuide('att', '+13055550142', makeT('en'));
    expect(g.setup[0].dial).toBe('**61*+13055550142**20#');
    expect(g.setup.map((s) => s.dial)).toContain('**004*+13055550142#');
    expect(g.cancel[0].dial).toBe('##004#');
  });
  test('Verizon and landline use 10 digits', () => {
    expect(forwardingGuide('verizon', '+13055550142', makeT('en')).setup[0].dial).toBe('*713055550142');
    expect(forwardingGuide('landline', '+13055550142', makeT('en')).cancel.map((c) => c.dial)).toContain('*73');
  });
  test('formatting helpers', () => {
    expect(tenDigits('+1 (305) 555-0142')).toBe('3055550142');
    expect(prettyPhone('+13055550142')).toBe('+1 305 555 0142');
  });
});

describe('onboarding steps derive from facts', () => {
  const base = {
    has_knowledge: false, owner_phone_verified: false, provisioning_allowed: false, provisioned: false, first_call_at: null,
  };
  test('nextStep order', () => {
    expect(nextStep(base)).toBe('info');
    expect(nextStep({ ...base, has_knowledge: true })).toBe('verify');
    expect(nextStep({ ...base, has_knowledge: true, owner_phone_verified: true })).toBe('plan');
    expect(nextStep({ ...base, has_knowledge: true, owner_phone_verified: true, provisioning_allowed: true })).toBe('provision');
    expect(nextStep({ ...base, has_knowledge: true, owner_phone_verified: true, provisioning_allowed: true, provisioned: true })).toBe('connect');
    expect(nextStep({ ...base, has_knowledge: true, owner_phone_verified: true, provisioning_allowed: true, provisioned: true, first_call_at: 'x' })).toBe('done');
  });
  test('requested step is clamped to what the facts allow', () => {
    const s = { ...base, has_knowledge: true, current_step: 'verify' } as unknown as OnboardingStatus;
    expect(maxStepFor(s)).toBe('verify');
    expect(resolveStep('test', s)).toBe('review');
    expect(resolveStep('review', s)).toBe('review');
  });
});

describe('knowledge model', () => {
  test('dollars in UI, dollars stored; blank price means quote', () => {
    expect(parsePrice('$1,234.50')).toBe(1234.5);
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('abc')).toBeUndefined();
    const d = draftFromExtraction(ex);
    d.services[1].price = '';
    const p = toKnowledgePayload(d);
    expect(p.services[0].base_price).toBe(150);
    expect(p.services[1].base_price).toBeNull();
  });
  test('validation catches bad hours, prices and half-filled FAQs', () => {
    const d = draftFromExtraction(ex);
    d.hours.monday = { open: true, from: '18:00', to: '09:00' };
    d.services[0].price = '12x';
    d.faqs.push({ uid: 99, question: 'Q only', answer: '' });
    const e = validateDraft(d);
    expect(e.hours.monday).toBeTruthy();
    expect(e.services[0]?.price).toBeTruthy();
    expect(e.faqs[1]?.answer).toBeTruthy();
    expect(hasErrors(validateDraft(draftFromExtraction(ex)))).toBe(false);
  });
  test('re-extract merge keeps manual edits and only adds or fills', () => {
    const mine = draftFromExtraction(ex);
    mine.services[0].price = '175'; // manual edit
    mine.services[1].description = '';
    const next: ExtractionResult = {
      ...ex,
      services: [
        { name: 'AC Repair', base_price: 120, description: 'Diagnose and fix' },
        { name: 'Tune-up', base_price: 99, description: 'Seasonal check' },
        { name: 'Duct cleaning', base_price: 300 },
      ],
      faqs: [...ex.faqs, { question: 'Warranty?', answer: '1 year' }],
      service_area: ['Miami', 'Hialeah'],
    };
    const { draft, summary } = mergeExtraction(mine, next);
    expect(draft.services[0].price).toBe('175'); // kept
    expect(draft.services[0].description).toBe('Diagnose and fix'); // filled
    expect(draft.services[1].price).toBe('89'); // kept
    expect(draft.services[1].description).toBe('Seasonal check');
    expect(draft.services.map((s) => s.name)).toContain('Duct cleaning');
    expect(draft.faqs.length).toBe(2);
    expect(draft.serviceArea).toContain('Hialeah');
    expect(summary.keptConflicts).toBeGreaterThan(0);
  });
  test('snapshot ignores uids and detects edits', () => {
    const a = draftFromServer({ name: 'A', owner_name: null, service_area: [], hours: {} }, null);
    const b = { ...a, name: 'B' };
    expect(snapshot(a)).not.toBe(snapshot(b));
    expect(snapshot(a)).toBe(snapshot({ ...a }));
  });
});
