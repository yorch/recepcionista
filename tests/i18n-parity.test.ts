/**
 * The message catalogs: every English key exists in Spanish and vice versa, with the same {placeholders}; every key the source uses
 * exists; the API error map points at real messages; the pure inline-L10n modules actually translate.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../src/lib/i18n/en';
import { es } from '../src/lib/i18n/es';
import { placeholdersOf } from '../src/lib/i18n/core';
import { API_ERROR_SLUGS } from '../src/lib/i18n/catalog/error-keys';
import { apiErrorKey } from '../src/lib/i18n/api-errors';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const enMap = en as Record<string, string>;
const esMap = es as Record<string, string>;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !p.includes('/lib/i18n/catalog/')) out.push(p);
  }
  return out;
}

describe('catalog parity', () => {
  test('the same keys in both languages', () => {
    const onlyEn = Object.keys(enMap).filter((k) => !(k in esMap));
    const onlyEs = Object.keys(esMap).filter((k) => !(k in enMap));
    expect({ onlyEn, onlyEs }).toEqual({ onlyEn: [], onlyEs: [] });
  });

  test('the same interpolation parameters per key', () => {
    const bad = Object.keys(enMap).filter((k) => JSON.stringify(placeholdersOf(enMap[k])) !== JSON.stringify(placeholdersOf(esMap[k] ?? '')));
    expect(bad.map((k) => `${k}: en=${placeholdersOf(enMap[k])} es=${placeholdersOf(esMap[k] ?? '')}`)).toEqual([]);
  });

  test('no empty messages, and Spanish is really translated (not a copy of the English)', () => {
    const empty = Object.keys(enMap).filter((k) => !enMap[k].trim() || !esMap[k]?.trim());
    expect(empty).toEqual([]);
    // Identical text is fine for names, numbers and symbols only.
    const same = Object.keys(enMap).filter((k) => enMap[k] === esMap[k] && /[A-Za-z]{4}/.test(enMap[k].replace(/\{[^}]*\}/g, '')));
    const allowed = new Set(['auth.login.title', 'common.english', 'common.spanish', 'bsw.option', 'meta.titleTemplate', 'gcalnotice.region', 'cn.carrier.att', 'cn.carrier.tmobile', 'cn.carrier.verizon', 'common.minutesShort', 'callmode.fn.placeholder', 'vf.namePlaceholder', 'demo.script.spanish', 'callLang.mixed', 'set.gcal.title', 'land.copyright', 'ts.duration', 'pay.cvc', 'bill.usage.of', 'mail.usage.amount', 'common.dash', 'bill.plan', 'bill.planName', 'booking.tab.agenda', 'agenda.region', 'callLang.es', 'ob.step.plan']);
    expect(same.filter((k) => !allowed.has(k))).toEqual([]);
  });

  test('plural messages have an `other` branch in both languages', () => {
    for (const k of Object.keys(enMap)) {
      if (!enMap[k].includes(', plural,')) continue;
      expect(enMap[k]).toContain('other {');
      expect(esMap[k]).toContain('other {');
    }
  });

  test('keys written as t(\'literal\') in the source exist in the catalog', () => {
    const missing: string[] = [];
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g)) {
        if (!(m[1] in enMap)) missing.push(`${f.replace(SRC, 'src')}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('API error mapping', () => {
  test('every mapped API error has an English and a Spanish message', () => {
    const missing = [...new Set(Object.values(API_ERROR_SLUGS))].filter((s) => !(`err.${s}` in enMap) || !(`err.${s}` in esMap));
    expect(missing).toEqual([]);
  });
  test('known strings map, unknown strings do not', () => {
    expect(apiErrorKey('rate limit exceeded')).toBe('err.rateLimit');
    expect(apiErrorKey('Request failed (500)')).toBe('err.requestFailed');
    expect(apiErrorKey('some brand new server message')).toBeNull();
  });
});

describe('pure modules with inline { en, es } text', () => {
  test('knowledge draft validation speaks Spanish on request', async () => {
    const { validateDraft, draftFromPack } = await import('../src/components/knowledge/model');
    const d = draftFromPack('hvac', 'en', 'Ana', '');
    const en1 = validateDraft({ ...d, name: '' });
    const es1 = validateDraft({ ...d, name: '' }, { lang: 'es' });
    expect(en1.name).toBe('Enter your business name.');
    expect(es1.name).toBe('Ingrese el nombre de su negocio.');
  });
  test('readiness messages are available in Spanish', async () => {
    const { kbReadiness } = await import('../src/lib/kb/readiness');
    const r = kbReadiness({ services: [], faqs: [] }, { hours: {}, service_area: [], owner_name: '' }, 'es');
    expect(r.blockers.map((b) => b.message).join(' ')).toMatch(/Agregue|Configure/);
    expect(r.warnings.map((b) => b.message).join(' ')).toMatch(/Agregue/);
  });
});
