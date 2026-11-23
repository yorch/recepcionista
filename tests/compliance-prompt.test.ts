import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt, complianceRules, promptIsDeficient, COMPLIANCE_MARKER } from '../src/lib/kb';
import { cleanDisclosure, disclosureFor, hasMandatoryNotice, DEFAULT_DISCLOSURE, MAX_DISCLOSURE_LENGTH } from '../src/lib/kb/disclosure';
import { firstMessageFor } from '../src/lib/voice/elevenlabs';
import { CALL_911_EN, CALL_911_ES } from '../src/lib/voice/emergency';
import type { Business } from '../src/lib/types';

const biz: Business = {
  id: 'b1', name: 'Cool Air Miami', phone: '+13055550100', owner_name: 'Jorge', owner_phone: '+13055559999',
  service_area: ['Miami'], hours: {}, status: 'live', created_at: '2026-01-01T00:00:00Z',
} as Business;
const kb = { services: [], faqs: [], pricing_notes: '' };

describe('system prompt compliance rules', () => {
  const prompt = buildSystemPrompt(biz, kb);

  test('includes disclosure, decline and 911 rules', () => {
    expect(prompt).toContain(COMPLIANCE_MARKER);
    expect(prompt).toMatch(/AI assistant and may be recorded/);
    expect(prompt).toContain('consent_declined=true');
    expect(prompt).toMatch(/take a message for a human callback/i);
    expect(prompt).toContain('hang up and call 911');
    for (const hazard of ['gas', 'carbon monoxide', 'fire', 'smoke', 'sparking', 'flooding']) {
      expect(prompt.toLowerCase()).toContain(hazard);
    }
  });
  test('911 comes before flag_emergency in the rule', () => {
    const rule = complianceRules(biz);
    expect(rule.indexOf('call 911')).toBeLessThan(rule.indexOf('use flag_emergency'));
    expect(rule).toMatch(/BEFORE asking questions/);
  });
  test('owner phone never appears in the prompt synced to the provider', () => {
    expect(prompt).not.toContain('+13055559999');
    expect(prompt).not.toContain('3055559999');
  });
  test('prompts missing the compliance block are flagged deficient', () => {
    expect(promptIsDeficient(prompt)).toBe(false);
    expect(promptIsDeficient(prompt.replace(COMPLIANCE_MARKER, '## OTHER'))).toBe(true);
  });
});

describe('recording disclosure', () => {
  test('first message opens with the default disclosure', () => {
    expect(firstMessageFor(biz).startsWith(DEFAULT_DISCLOSURE)).toBe(true);
  });
  test('custom text extends the mandatory notice and never replaces it', () => {
    const custom = { ...biz, recording_disclosure_text: 'Hi!' };
    const spoken = firstMessageFor(custom);
    expect(spoken.startsWith('Hi! ')).toBe(true);
    expect(spoken).toContain(DEFAULT_DISCLOSURE); // appended: the AI + recording notice is always spoken
    // a text that already carries the notice in both languages is used as written
    const full = 'We use an AI assistant and calls may be recorded. Usamos una inteligencia artificial y la llamada puede ser grabada.';
    expect(disclosureFor({ recording_disclosure_text: full })).toBe(full);
    expect(hasMandatoryNotice(full)).toBe(true);
    expect(hasMandatoryNotice('Hi!')).toBe(false);
    expect(hasMandatoryNotice('Calls are recorded by our AI helper.')).toBe(false); // English only
    expect(disclosureFor({ recording_disclosure_text: 'x'.repeat(5000) }).startsWith('x'.repeat(MAX_DISCLOSURE_LENGTH))).toBe(true);
    expect(disclosureFor({ recording_disclosure_text: 'x'.repeat(5000) })).toContain(DEFAULT_DISCLOSURE);
    expect(disclosureFor({ recording_disclosure_text: '   ' })).toBe(DEFAULT_DISCLOSURE);
    expect(cleanDisclosure('a\n\nb\t c')).toBe('a b c');
  });
});

describe('flag_emergency spoken advice', () => {
  test('911 sentences cover gas, CO, smoke and fire in both languages', () => {
    for (const s of [CALL_911_EN, CALL_911_ES]) expect(s).toContain('911');
    expect(CALL_911_EN).toMatch(/gas.*carbon monoxide.*smoke.*fire/);
  });
});
