/** Vertical packs: shape validity, prompts per vertical (no HVAC wording outside HVAC), emergency handling, SMS, briefing, readiness and seeds. Pure: no database. */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCallScript, buildSystemPrompt, COMPLIANCE_MARKER, generateKnowledgeBase, promptIsDeficient, REQUIRED_TOOLS } from '../src/lib/kb';
import { kbReadiness, readinessOfDraft } from '../src/lib/kb/readiness';
import { cleanDisclosure } from '../src/lib/kb/disclosure';
import { templateResult } from '../src/lib/extraction';
import { confirmationSms, FOLLOWUP_NOTICE_RE, gratitudeSms, paymentLinkSms, rescheduleSms, SMS_LIMIT } from '../src/lib/messaging/templates';
import { ownerPrompt } from '../src/lib/voice/owner/prompt';
import { inferUrgency, normalizeLanguage } from '../src/lib/voice/postcall';
import { CALL_911_EN, CALL_911_ES, call911For, call911Hazards } from '../src/lib/voice/emergency';
import { DEFAULT_VERTICAL, isVertical, l10nOk, LIFE_SAFETY_STRONG, PACKS, packFaqs, packOf, packPricingNotes, packServices, tx } from '../src/lib/verticals';
import { draftFromPack, validateDraft, hasErrors, withPackDefaults, draftFromExtraction, LIMITS } from '../src/components/knowledge/model';
import { fallbackScript } from '../src/lib/briefing';
import { VERTICALS, type Booking, type Business, type Vertical } from '../src/lib/types';

const biz = (vertical?: Vertical | string): Business => ({
  id: 'b1', name: 'Acme Co', phone: '+13055550100', owner_name: 'Jorge', owner_phone: '+13055559999', service_area: ['Miami'], hours: {}, status: 'live',
  created_at: '2026-01-01T00:00:00Z', ...(vertical === undefined ? {} : { vertical }),
} as Business);
const kb = { services: [], faqs: [], pricing_notes: '' };
const NON_HVAC = VERTICALS.filter((v) => v !== 'hvac');
const HVAC_WORDS = /\bHVAC\b|\bAC\b|air condition|cooling|heating|furnace|refrigerant|thermostat|compressor/i;
const booking = (over: Partial<Booking> = {}): Booking => ({
  id: 'k1', business_id: 'b1', customer_name: 'Maria Lopez', customer_phone: '+13055550123', service: 'Filling', scheduled_at: '2027-03-10T15:00:00.000Z',
  address: '12 Main St', price_estimate: 18000, deposit_paid: false, status: 'confirmed', duration_minutes: 60, created_at: '2026-01-01T00:00:00Z', ...over,
} as Booking);

describe('pack registry', () => {
  test('the pack ids are exactly the VERTICALS of the schema CHECK, in the same order', () => {
    expect(Object.keys(PACKS)).toEqual([...VERTICALS]);
    for (const v of VERTICALS) expect(PACKS[v].id).toBe(v);
    expect(DEFAULT_VERTICAL).toBe('hvac');
  });
  test('packOf falls back to hvac for missing or unknown input and accepts a business, an id or nothing', () => {
    for (const x of [undefined, null, '', 'pirate', { vertical: undefined }, { vertical: 'nope' as never }]) expect(packOf(x as never).id).toBe('hvac');
    expect(packOf('dental').id).toBe('dental');
    expect(packOf({ vertical: 'plumbing' }).id).toBe('plumbing');
    expect(isVertical('general')).toBe(true);
    expect(isVertical('HVAC')).toBe(false);
    expect(isVertical(3)).toBe(false);
  });
});

for (const v of VERTICALS) describe(`pack shape: ${v}`, () => {
  const p = PACKS[v];
  test('every text exists in English and Spanish', () => {
    const texts = [
      p.label, p.blurb, p.persona, p.provider, p.pricing.notes, p.pricing.confirmLine, p.pricing.unpriced, p.pricing.fallbackService.name, p.pricing.fallbackService.description,
      p.emergency.call911, p.prompt.greeting, p.prompt.mixExample, p.prompt.mixTerms, p.script.triage, p.script.booking, p.sms.fallbackService,
      p.briefing.providerWord, p.hints.testPhrase, p.hints.servicePlaceholder, ...p.prompt.qualifying,
      ...p.services.flatMap((s) => [s.name, s.description]), ...p.faqs.flatMap((f) => [f.question, f.answer]), ...p.emergency.rules,
      ...(p.sms.confirmationNote ? [p.sms.confirmationNote] : []), ...(p.emergency.none ? [p.emergency.none] : []),
    ];
    for (const t of texts) expect(l10nOk(t)).toBe(true);
    if (p.emergency.enabled) { expect(l10nOk(p.emergency.triage)).toBe(true); }
  });
  test('services: 3+ priced, bounded names, durations and prices that fit the knowledge-base limits', () => {
    expect(p.services.length).toBeGreaterThanOrEqual(3);
    expect(p.services.length).toBeLessThanOrEqual(LIMITS.services);
    for (const s of p.services) {
      for (const lang of ['en', 'es'] as const) {
        expect(tx(s.name, lang).length).toBeLessThanOrEqual(LIMITS.serviceName);
        expect(tx(s.description, lang).length).toBeLessThanOrEqual(LIMITS.description);
      }
      expect(s.base_price).toBeGreaterThan(0);
      expect(s.base_price).toBeLessThanOrEqual(100_000);
      expect(Number.isInteger(s.duration_minutes) && s.duration_minutes >= 5 && s.duration_minutes <= 1440).toBe(true);
    }
    expect(new Set(p.services.map((s) => s.name.en)).size).toBe(p.services.length);
  });
  test('faqs and pricing notes fit the limits; hours have an open day with open before close', () => {
    expect(p.faqs.length).toBeGreaterThanOrEqual(2);
    for (const lang of ['en', 'es'] as const) {
      for (const f of packFaqs(p, lang)) { expect(f.question.length).toBeLessThanOrEqual(LIMITS.question); expect(f.answer.length).toBeLessThanOrEqual(LIMITS.answer); }
      expect(packPricingNotes(p, lang).length).toBeLessThanOrEqual(LIMITS.notes);
    }
    const open = Object.values(p.hours).filter(Boolean) as { open: string; close: string }[];
    expect(open.length).toBeGreaterThanOrEqual(5);
    for (const h of open) expect(h.open < h.close).toBe(true);
  });
  test('a seeded draft is valid and meets the go-live minimum on its own (the owner then edits it)', () => {
    for (const lang of ['en', 'es'] as const) {
      const d = draftFromPack(v, lang, 'Jorge', 'Acme');
      expect(hasErrors(validateDraft(d))).toBe(false);
      // A template never invents the service area: it is the one thing the owner must still type in.
      expect(readinessOfDraft(d, v).blockers.map((b) => b.key)).toEqual(['service_area']);
      expect(readinessOfDraft({ ...d, serviceArea: 'Dade County' }, v).blockers).toEqual([]);
    }
  });
  test('emergency block is internally consistent', () => {
    const e = p.emergency;
    expect(l10nOk(e.call911)).toBe(true);
    expect(e.call911.en).toContain('911');
    expect(e.call911.es).toContain('911');
    expect(e.call911For.length).toBeGreaterThan(0);
    if (e.enabled) {
      expect(e.rules.length).toBeGreaterThanOrEqual(3);
      expect(e.keywords.length).toBeGreaterThan(4);
      expect(e.strong.length).toBeGreaterThan(0);
      for (const w of e.strong) expect(e.keywords).toContain(w);
      expect(e.none).toBeNull();
    } else {
      expect(e.rules).toEqual([]);
      expect(e.keywords).toEqual([]);
      expect(e.strong).toEqual([]);
      expect(l10nOk(e.none)).toBe(true);
    }
    for (const w of [...e.keywords, ...e.strong]) expect(w).toBe(w.toLowerCase());
  });
  test('the confirmation note (when there is one) keeps the SMS inside one message and the mandatory texts', () => {
    for (const language of ['en', 'es', 'mixed'] as const) {
      const sms = confirmationSms({ business: biz(v), booking: booking(), language });
      expect(sms.length).toBeLessThanOrEqual(SMS_LIMIT);
      expect(FOLLOWUP_NOTICE_RE.test(sms)).toBe(true);
      expect(sms).toMatch(/Reply C|Text C|Responda C/);
    }
  });
});

describe('system prompt per vertical', () => {
  for (const v of VERTICALS) test(`${v}: the 911 rule, disclosure, every tool and its own emergency section are present and the prompt is healthy`, () => {
    const prompt = buildSystemPrompt(biz(v), kb);
    expect(prompt).toContain(COMPLIANCE_MARKER);
    expect(prompt).toContain('hang up and call 911');
    expect(prompt).toContain('## EMERGENCIES');
    for (const t of REQUIRED_TOOLS) expect(prompt).toContain(t);
    expect(prompt.toLowerCase()).toContain('card number');
    expect(promptIsDeficient(prompt, v)).toBe(false);
    expect(prompt).not.toContain('{name}');
    expect(prompt).toContain('Thank you for calling Acme Co');
  });
  for (const v of NON_HVAC) test(`${v}: no HVAC wording anywhere in the prompt, script, services seed or owner prompt`, () => {
    const prompt = buildSystemPrompt(biz(v), kb);
    expect(prompt).not.toMatch(HVAC_WORDS);
    expect(buildCallScript(kb, biz(v))).not.toMatch(HVAC_WORDS);
    const generated = generateKnowledgeBase(templateResult('Acme', v), biz(v));
    expect(JSON.stringify(generated)).not.toMatch(HVAC_WORDS);
    expect(JSON.stringify(PACKS[v])).not.toMatch(HVAC_WORDS);
    expect(ownerPrompt(biz(v))).not.toMatch(HVAC_WORDS);
  });
  test('hvac keeps its long-standing wording', () => {
    const prompt = buildSystemPrompt(biz('hvac'), kb);
    expect(prompt).toContain('- Water leaking from the system or around it');
    expect(prompt).toContain('- No cooling AND a vulnerable occupant (baby, elderly, sick person) in the home');
    expect(prompt).toContain('3. TRIAGE FOR EMERGENCY: ask the emergency questions (water leaking? anyone vulnerable at home? burning smell? total failure in extreme heat?). If yes, jump to the emergency procedure above.');
    expect(prompt).toContain('say the technician confirms the exact price after diagnosis, before any work begins.');
    expect(prompt).toContain('"Hola, my AC is not cooling"');
    expect(prompt).toContain('- Deposits are capped at a maximum of $500.');
    expect(prompt).toContain('front-desk person for a home-services trade company');
  });
  test('no vertical = hvac: a business without one gets the hvac prompt, an unknown one too', () => {
    expect(buildSystemPrompt(biz(), kb)).toBe(buildSystemPrompt(biz('hvac'), kb));
    expect(buildSystemPrompt(biz('pirate'), kb)).toBe(buildSystemPrompt(biz('hvac'), kb));
  });
  test('trades with emergencies list their own rules; trades without say so and have no triage step', () => {
    expect(buildSystemPrompt(biz('plumbing'), kb)).toContain('A burst or actively leaking pipe');
    expect(buildSystemPrompt(biz('electrical'), kb)).toContain('Sparking, arcing');
    expect(buildSystemPrompt(biz('dental'), kb)).toContain('dental trauma');
    for (const v of ['cleaning', 'landscaping', 'general'] as const) {
      const p = buildSystemPrompt(biz(v), kb);
      expect(p).toContain('does not run emergency dispatch');
      expect(p).not.toContain('An emergency is any of');
      expect(p).not.toContain('TRIAGE FOR EMERGENCY');
      expect(p).toContain('QUALIFY THE JOB');
      expect(p).toContain('hang up and call 911'); // the life-safety rule stays everywhere
    }
  });
  test('deposits: on by default for hvac/plumbing/electrical/landscaping, only when the owner says so elsewhere', () => {
    for (const v of VERTICALS) {
      const p = buildSystemPrompt(biz(v), kb);
      if (PACKS[v].deposits.defaultOn) expect(p).not.toContain('does not take a deposit by default');
      else expect(p).toContain('does not take a deposit by default');
      expect(p).toContain('$500'); // the cap holds either way
      expect(p).toContain('NEVER ask for or accept a full card number');
    }
    expect(PACKS.hvac.deposits.defaultOn).toBe(true);
    expect(PACKS.dental.deposits.defaultOn).toBe(false);
  });
  test('a prompt written for another vertical is deficient for this one (so provisioning rebuilds it)', () => {
    const hvac = buildSystemPrompt(biz('hvac'), kb);
    expect(promptIsDeficient(hvac, 'hvac')).toBe(false);
    expect(promptIsDeficient(hvac)).toBe(false); // legacy call: default vertical
    expect(promptIsDeficient(hvac, 'plumbing')).toBe(true);
    expect(promptIsDeficient(hvac, 'cleaning')).toBe(true);
    expect(promptIsDeficient(buildSystemPrompt(biz('cleaning'), kb), 'hvac')).toBe(true);
    expect(promptIsDeficient(buildSystemPrompt(biz('plumbing'), kb).replace('## EMERGENCIES', '## OTHER'), 'plumbing')).toBe(true);
  });
  test('services with no price read "price on ..." from the pack', () => {
    const svc = [{ name: 'Thing', base_price: null }];
    expect(buildSystemPrompt(biz('hvac'), { ...kb, services: svc })).toContain('price on diagnosis');
    expect(buildSystemPrompt(biz('dental'), { ...kb, services: svc })).toContain('price after exam');
    expect(buildSystemPrompt(biz('cleaning'), { ...kb, services: svc })).toContain('price on quote');
  });
  test('the owner name reaches the emergency section', () => {
    expect(buildSystemPrompt(biz('plumbing'), kb)).toContain('to reach Jorge right away');
  });
});

describe('call script', () => {
  test('hvac keeps the triage script, others get their own; trades without emergencies get qualifying questions', () => {
    expect(buildCallScript(kb, biz('hvac'))).toContain('is there any water leaking, a burning smell');
    expect(buildCallScript(kb)).toContain('2) TRIAGE');
    expect(buildCallScript(kb, biz('plumbing'))).toContain('sewage backing up');
    expect(buildCallScript(kb, biz('cleaning'))).toContain('2) QUALIFYING QUESTIONS');
    expect(buildCallScript(kb, biz('cleaning'))).toContain('No emergency triage for this business');
    expect(buildCallScript(kb, biz('dental'))).toContain('I can get you in with us');
    for (const v of VERTICALS) { const s = buildCallScript(kb, biz(v)); expect(s).toContain('ES:'); expect(s).toContain('4) CLOSE'); }
  });
});

describe('emergency handling from the pack', () => {
  test('the hvac 911 copy is unchanged, the default, and what the legacy constants say', () => {
    expect(call911For(biz('hvac'))).toEqual({ en: CALL_911_EN, es: CALL_911_ES });
    expect(call911For(biz())).toEqual({ en: CALL_911_EN, es: CALL_911_ES });
    expect(call911For(null)).toEqual({ en: CALL_911_EN, es: CALL_911_ES });
    expect(call911Hazards(biz('hvac'))).toEqual(['gas', 'carbon_monoxide', 'smoke', 'fire']);
  });
  test('every vertical tells the caller to hang up and call 911, in both languages', () => {
    for (const v of VERTICALS) {
      const c = call911For(biz(v));
      expect(c.en).toMatch(/hang up and call 911/);
      expect(c.es).toMatch(/cuelgue y llame al 911/);
    }
  });
  test('trade-specific hazards: plumbing flooding near electricity, electrical downed line, dental breathing/bleeding', () => {
    expect(call911For(biz('plumbing')).en).toMatch(/gas smell/);
    expect(call911For(biz('plumbing')).en).toMatch(/electrical outlets/);
    expect(call911For(biz('electrical')).en).toMatch(/downed power line/);
    expect(call911For(biz('dental')).en).toMatch(/breathing|bleeding/);
    expect(call911For(biz('cleaning')).en).toBe('If anyone is in danger, hang up and call 911 right now.');
  });
  test('post-call urgency reads the vertical keywords (hvac behaviour unchanged)', () => {
    expect(inferUrgency('My AC is blowing warm air')).toBe('routine');
    expect(inferUrgency('there is water leaking from the unit', biz('hvac'))).toBe('emergency');
    expect(inferUrgency('there is water leaking from the unit')).toBe('emergency');
    expect(inferUrgency('no cooling and a baby at home', biz('hvac'))).toBe('emergency');
    expect(inferUrgency('hola quiero mantenimiento', biz('hvac'))).toBe('routine');
    expect(inferUrgency('   ', biz('hvac'))).toBe('unsure');
    expect(inferUrgency('a pipe burst and the kitchen is flooding', biz('plumbing'))).toBe('emergency');
    expect(inferUrgency('sparks coming from the panel', biz('electrical'))).toBe('emergency');
    expect(inferUrgency('my tooth got knocked out playing soccer', biz('dental'))).toBe('emergency');
    expect(inferUrgency('I have a toothache since last week', biz('dental'))).toBe('unsure'); // a keyword without a strong one
    expect(inferUrgency('I would like a cleaning next week', biz('dental'))).toBe('routine');
  });
  test('trades without emergencies have no keyword urgency, only the universal danger-to-life floor', () => {
    for (const v of ['cleaning', 'landscaping', 'general'] as const) {
      expect(inferUrgency('there is a leak, water everywhere, no cooling, burning, flooding', biz(v))).toBe('routine');
      expect(inferUrgency('I smell gas smell in the kitchen', biz(v))).toBe('emergency');
    }
    expect(LIFE_SAFETY_STRONG.length).toBeGreaterThan(3);
    expect(inferUrgency('huele a gas, olor a gas', biz('cleaning'))).toBe('emergency');
  });
  test('Spanglish detection uses the pack trade words (AC for hvac, not for others)', () => {
    expect(normalizeLanguage(undefined, 'hola, my AC is broken, please', biz('hvac'))).toBe('mixed');
    expect(normalizeLanguage(undefined, 'hola, my AC is broken, please')).toBe('mixed');
    expect(normalizeLanguage(undefined, 'hola, my plomero is late, please', biz('plumbing'))).toBe('mixed');
    expect(normalizeLanguage(undefined, 'hello there', biz('dental'))).toBeNull();
    expect(normalizeLanguage('es-MX', '', biz('cleaning'))).toBe('es');
  });
});

describe('seeds', () => {
  test('templateResult: hvac default is the long-standing template; every vertical builds its own and the language switches', () => {
    const h = templateResult('Cool Air');
    expect(h.source).toBe('template');
    expect(h.services.map((s) => s.name)).toEqual(['AC Repair', 'AC Maintenance / Tune-up', 'AC Installation / Replacement', 'Emergency AC Service']);
    expect(h.faqs).toHaveLength(2);
    expect(h.pricing_notes).toContain('Deposits are capped at $500');
    for (const v of VERTICALS) {
      const en = templateResult('X', v, 'en');
      const es = templateResult('X', v, 'es');
      expect(en.services.map((s) => s.name)).toEqual(PACKS[v].services.map((s) => s.name.en));
      expect(es.services.map((s) => s.name)).toEqual(PACKS[v].services.map((s) => s.name.es));
      expect(en.hours.monday).toBeTruthy();
    }
    expect(templateResult('X', 'dental').pricing_notes).toContain('No deposit is taken by default');
  });
  test('pack seeds are copies: editing the result never changes the pack', () => {
    const s = packServices(PACKS.plumbing);
    s[0].name = 'Changed';
    s[0].base_price = 1;
    expect(PACKS.plumbing.services[0].name.en).toBe('Leak Repair');
    expect(packServices(PACKS.plumbing)[0].base_price).toBe(150);
  });
  test('withPackDefaults fills only empty FAQs and notes: a scraped draft is never overwritten', () => {
    const scraped = draftFromExtraction({ name: 'X', services: [{ name: 'Only', base_price: 10 }], hours: {}, service_area: [], faqs: [{ question: 'Q?', answer: 'A.' }], pricing_notes: 'Mine', confidence: 'high', source: 'scrape' });
    const kept = withPackDefaults(scraped, 'dental');
    expect(kept.faqs.map((f) => f.question)).toEqual(['Q?']);
    expect(kept.pricingNotes).toBe('Mine');
    expect(kept.services.map((s) => s.name)).toEqual(['Only']);
    const bare = draftFromExtraction({ name: 'X', services: [{ name: 'Only', base_price: 10 }], hours: {}, service_area: [], faqs: [], pricing_notes: '', confidence: 'low', source: 'scrape' });
    const filled = withPackDefaults(bare, 'dental');
    expect(filled.faqs.length).toBe(PACKS.dental.faqs.length);
    expect(filled.pricingNotes).toContain('No deposit is taken by default');
    expect(filled.services.map((s) => s.name)).toEqual(['Only']);
  });
  test('generateKnowledgeBase uses the pack for its fallback service and pricing notes', () => {
    const empty = { name: 'X', services: [], hours: {}, service_area: [], faqs: [], pricing_notes: '', confidence: 'low' as const, source: 'scrape' as const };
    const g = generateKnowledgeBase(empty, biz('cleaning'));
    expect(g.services[0].name).toBe('Home cleaning');
    expect(g.pricing_notes).toContain('No deposit is taken by default');
    expect(g.system_prompt).not.toMatch(HVAC_WORDS);
    expect(generateKnowledgeBase(empty, biz()).services[0].name).toBe('Service call');
  });
});

describe('messaging and briefing read the pack', () => {
  test('confirmation: no note for hvac (text unchanged), the note for others when it fits, dropped when it would not', () => {
    expect(confirmationSms({ business: biz('hvac'), booking: booking({ service: 'AC Repair' }) })).toBe(
      confirmationSms({ business: biz(), booking: booking({ service: 'AC Repair' }) }));
    expect(confirmationSms({ business: biz('hvac'), booking: booking({ service: 'AC Repair' }) })).not.toContain('Please');
    expect(confirmationSms({ business: biz('dental'), booking: booking() })).toContain('Please arrive 10 minutes early.');
    expect(confirmationSms({ business: biz('dental'), booking: booking(), language: 'es' })).toContain('Por favor llegue 10 minutos antes.');
    const long = confirmationSms({ business: biz('dental'), booking: booking({ address: 'x'.repeat(200), service: 'y'.repeat(200) }) });
    expect(long.length).toBeLessThanOrEqual(SMS_LIMIT);
    expect(FOLLOWUP_NOTICE_RE.test(long)).toBe(true);
  });
  test('the fallback service word comes from the pack in every customer text', () => {
    const b = booking({ service: '' });
    expect(confirmationSms({ business: biz('cleaning'), booking: b })).toContain('Confirmed — cleaning,');
    expect(confirmationSms({ business: biz('hvac'), booking: b })).toContain('Confirmed — service,');
    expect(gratitudeSms({ business: biz('dental'), booking: b })).toContain('how did the appointment go');
    expect(rescheduleSms({ business: biz('plumbing'), booking: b })).toContain('Your plumbing visit was moved');
    expect(paymentLinkSms({ business: biz('electrical'), amount_cents: 5000, url: 'https://x.test/p' })).toContain('deposit for electrical visit');
    expect(paymentLinkSms({ business: biz('hvac'), amount_cents: 5000, url: 'https://x.test/p' })).toContain('deposit for service');
  });
  test('the automatic briefing states only data-derived facts (no invented action or customer reaction), for every trade', () => {
    const data = {
      calls: [{ id: 'c1', urgency: 'emergency', summary: 's', language: 'es', caller_name: 'Ana', flagged_reason: 'x' }],
      bookings: [], flagged: [], deposits: 0, stats: { revenue: 0 },
    } as never;
    for (const v of ['hvac', 'plumbing', 'dental'] as const) {
      const es = fallbackScript(biz(v), data);
      expect(es).toContain('resumen automático');
      expect(es).toContain('1 llamada marcada como emergencia'.replace('1 llamada', 'Una llamada'));
      expect(es).not.toMatch(/está enterado|quedó tranquilo|dejar todo listo|la manejé|Aproveché/i);
      expect(fallbackScript(biz(v), data, 'en')).not.toMatch(/knows|is calm|get everything ready|handled it/i);
    }
  });
  test('owner call-in prompt names the trade, carries no tenant data, keeps its rules', () => {
    const p = ownerPrompt({ name: 'Acme', locale_default: 'en', vertical: 'plumbing' });
    expect(p).toContain('a Plumbing business');
    expect(p).toContain('confirmed=false');
    expect(ownerPrompt({ name: 'Acme', locale_default: 'en' })).toContain('a HVAC business');
    expect(cleanDisclosure('x')).toBe('x');
  });
});

describe('readiness reads the vertical', () => {
  const none = { services: [], faqs: [] };
  test('the services blocker gives an example from the pack only when the vertical is known', () => {
    expect(kbReadiness(none).blockers.find((b) => b.key === 'services')!.message).not.toContain('For example');
    expect(kbReadiness(none, { vertical: 'plumbing' }).blockers.find((b) => b.key === 'services')!.message).toContain('For example: Leak Repair.');
    expect(kbReadiness(none, { vertical: null }).blockers.find((b) => b.key === 'services')!.message).toContain('For example: AC Repair.');
  });
});

describe('no HVAC wording is hard-coded outside the packs', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const dirs = ['lib/kb', 'lib/voice', 'lib/briefing', 'lib/messaging', 'lib/extraction', 'lib/verticals'];
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  test('prompt, voice, briefing, messaging and extraction code never names the trade (packs are the only place)', () => {
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of walk(join(root, dir))) {
        if (file.includes(`${join('lib', 'verticals', 'packs')}`) || file.endsWith('voicemail.ts')) continue; // packs hold the wording; voicemail.ts has the Twilio "AC..." SID pattern
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          if (/\bHVAC\b|\bAC\b/.test(line) || /air condition|furnace|refrigerant/i.test(line)) offenders.push(`${file}:${i + 1}: ${t.slice(0, 80)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
