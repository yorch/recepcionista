/** Locale resolution, Accept-Language parsing, interpolation / plurals and Intl formatting (src/lib/i18n). */
import { describe, expect, test } from 'bun:test';
import {
  formatDateTime, formatMoney, formatPhoneDisplay, localeOfRequest, makeT, normalizeLocale, parseAcceptLanguage, plural, pluralCategory,
  resolveLocale, translate,
} from '../src/lib/i18n';
import { dayLabelET, money, relative, timeET } from '../src/lib/format';
import { greetingFor, longDate } from '../src/components/dashboard/dates';
import { hourLabel, weekdayName } from '../src/lib/calendar';

describe('normalize and Accept-Language', () => {
  test('normalizeLocale', () => {
    expect(normalizeLocale('es-MX')).toBe('es');
    expect(normalizeLocale(' EN_us ')).toBe('en');
    expect(normalizeLocale('fr')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale(42)).toBeNull();
  });
  test('parseAcceptLanguage honours q-values and ignores unsupported languages', () => {
    expect(parseAcceptLanguage('es-MX,es;q=0.9,en;q=0.8')).toBe('es');
    expect(parseAcceptLanguage('en-US,en;q=0.9,es;q=0.8')).toBe('en');
    expect(parseAcceptLanguage('fr-FR,fr;q=0.9,es;q=0.5')).toBe('es');
    expect(parseAcceptLanguage('en;q=0.2, es;q=0.9')).toBe('es');
    expect(parseAcceptLanguage('de, fr')).toBeNull();
    expect(parseAcceptLanguage('*')).toBeNull();
    expect(parseAcceptLanguage('')).toBeNull();
    expect(parseAcceptLanguage(null)).toBeNull();
    expect(parseAcceptLanguage('es;q=0')).toBeNull();
  });
});

describe('resolveLocale: user -> cookie -> business -> Accept-Language -> en', () => {
  test('precedence', () => {
    expect(resolveLocale({ user: 'es', cookie: 'en', business: 'en', acceptLanguage: 'en' })).toBe('es');
    expect(resolveLocale({ user: 'en', cookie: 'es', business: 'es', acceptLanguage: 'es' })).toBe('en');
    expect(resolveLocale({ cookie: 'es', business: 'en', acceptLanguage: 'en' })).toBe('es');
    expect(resolveLocale({ business: 'es', acceptLanguage: 'en' })).toBe('es');
    expect(resolveLocale({ acceptLanguage: 'es-US,es;q=0.9' })).toBe('es');
    expect(resolveLocale({})).toBe('en');
  });
  test('invalid values fall through to the next source', () => {
    expect(resolveLocale({ user: 'xx', cookie: 'zz', business: 'es' })).toBe('es');
    expect(resolveLocale({ user: null, cookie: '', business: undefined, acceptLanguage: 'de' })).toBe('en');
  });
  test('localeOfRequest reads the rc_locale cookie, then the business, then Accept-Language', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(localeOfRequest(h({ cookie: 'a=1; rc_locale=es; b=2', 'accept-language': 'en' }))).toBe('es');
    expect(localeOfRequest(h({ 'accept-language': 'es' }), 'en')).toBe('en');
    expect(localeOfRequest(h({ 'accept-language': 'es-US' }))).toBe('es');
    expect(localeOfRequest(h({}))).toBe('en');
  });
});

describe('interpolation and plurals', () => {
  test('placeholders, missing params and braces in params', () => {
    expect(translate('en', 'bsw.option', { name: 'Acme', role: 'owner' })).toBe('Acme (owner)');
    expect(translate('es', 'team.invite.sent', { email: 'a@b.co' })).toBe('Invitación enviada a a@b.co.');
    expect(translate('en', 'team.invite.sent')).toBe('Invitation sent to {email}.'); // a missing param stays visible, never "undefined"
    expect(translate('en', 'team.invite.sent', { email: '{x}' })).toBe('Invitation sent to {x}.');
  });
  test('plural categories and the helper', () => {
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('es', 0)).toBe('other');
    expect(plural('es', 1, { one: 'cita', other: 'citas' })).toBe('cita');
    expect(plural('es', 3, { one: 'cita', other: 'citas' })).toBe('citas');
  });
  test('ICU-style plural messages in both languages', () => {
    const en = makeT('en');
    const es = makeT('es');
    expect(en('sec.2fa.recoveryLeft', { count: 1 })).toBe('1 unused recovery code left.');
    expect(en('sec.2fa.recoveryLeft', { count: 4 })).toBe('4 unused recovery codes left.');
    expect(es('sec.2fa.recoveryLeft', { count: 1 })).toBe('Le queda 1 código de recuperación sin usar.');
    expect(es('sec.2fa.recoveryLeft', { count: 0 })).toBe('Le quedan 0 códigos de recuperación sin usar.');
    expect(es('team.members', { count: 2 })).toBe('2 miembros');
    expect(en('cal.dayJobs', { label: 'Mon', count: 1 })).toBe('Mon, 1 job');
  });
  test('numbers inside plurals are formatted per locale', () => {
    expect(makeT('en')('team.members', { count: 1234 })).toBe('1,234 members');
  });
});

describe('Intl formatting', () => {
  const at = '2026-11-24T20:05:00Z';
  test('money: USD in both languages, whole dollars lose the decimals', () => {
    expect(formatMoney('en', 18900)).toBe('$189');
    expect(formatMoney('es', 123450)).toBe('$1,234.50');
    expect(formatMoney('es', null)).toBe('—');
    expect(money(18900, 'es')).toBe('$189');
  });
  test('dates and times follow the locale and the business zone', () => {
    expect(longDate(at, 'America/New_York', 'en')).toBe('Tuesday, November 24');
    expect(longDate(at, 'America/New_York', 'es')).toMatch(/martes, 24 de noviembre/);
    expect(timeET(at, 'America/New_York', 'en')).toBe('3:05 PM');
    expect(timeET(at, 'America/New_York', 'es')).toMatch(/3:05\s?p\.\s?m\./);
    expect(formatDateTime('es', at, { month: 'long', timeZone: 'UTC' })).toBe('noviembre');
  });
  test('relative time and day labels', () => {
    const now = Date.parse(at);
    expect(relative(new Date(now - 5 * 60_000).toISOString(), now, 'en')).toBe('5m ago');
    expect(relative(new Date(now - 5 * 60_000).toISOString(), now, 'es')).toBe('hace 5 min');
    expect(dayLabelET(at, 'America/New_York', new Date(at), 'es')).toBe('Hoy');
    expect(dayLabelET(at, 'America/New_York', new Date(at), 'en')).toBe('Today');
  });
  test('greeting, weekday and hour labels', () => {
    expect(greetingFor(new Date('2026-11-24T14:00:00Z'), 'America/New_York', 'en')).toBe('Good morning');
    expect(greetingFor(new Date('2026-11-24T14:00:00Z'), 'America/New_York', 'es')).toBe('Buenos días');
    expect(weekdayName(1, 'es')).toBe('lunes');
    expect(weekdayName(0, 'en', 'short')).toBe('Sun');
    expect(hourLabel(15 * 60, 'en')).toBe('3 PM');
    expect(hourLabel(15 * 60, 'es')).toMatch(/3\s?p\.\s?m\./);
  });
  test('phone display', () => {
    expect(formatPhoneDisplay('+13055550142')).toBe('(305) 555-0142');
    expect(formatPhoneDisplay('+525512345678')).toBe('+525512345678');
    expect(formatPhoneDisplay(null)).toBe('');
  });
});
