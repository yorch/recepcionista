/** Platform emails and owner texts are rendered in the recipient's language; the English wording is unchanged. */
import { describe, expect, test } from 'bun:test';
import { inviteTemplate, resetPasswordTemplate, verifyEmailTemplate } from '../src/lib/email/templates';
import { renderBillingEmail } from '../src/lib/billing/emails';
import { warningMessage } from '../src/lib/billing/warnings';
import { bannerFor } from '../src/lib/billing/banner-state';
import { changeSummary } from '../src/lib/voice/call-handling-changes';
import { fallbackScript } from '../src/lib/briefing';
import { kbReadiness } from '../src/lib/kb/readiness';
import type { Business } from '../src/lib/types';

describe('account emails', () => {
  test('English is the default and unchanged', () => {
    const v = verifyEmailTemplate({ link: 'https://x.test/verify-email?token=t' });
    expect(v.subject).toBe('Confirm your email address');
    expect(v.text).toContain('This link works once and expires in 24 hours.');
    expect(resetPasswordTemplate({ link: 'https://x.test/r' }).subject).toBe('Reset your password');
  });
  test('Spanish, usted, with the link and the footer', () => {
    const v = verifyEmailTemplate({ link: 'https://x.test/verify-email?token=t', locale: 'es' });
    expect(v.subject).toBe('Confirme su dirección de correo electrónico');
    expect(v.text).toContain('Este enlace funciona una sola vez y vence en 24 horas.');
    expect(v.text).toContain('https://x.test/verify-email?token=t');
    expect(v.html).toContain('Confirmar correo');
    expect(v.html).toContain('Si el botón no funciona');
    const r = resetPasswordTemplate({ link: 'https://x.test/r', locale: 'es' });
    expect(r.subject).toBe('Restablezca su contraseña');
    expect(r.text).toContain('60 minutos');
  });
  test('invitation: role, inviter and the quoted business name are localized and sanitised', () => {
    const i = inviteTemplate({ link: 'https://x.test/i', businessName: 'Acme https://evil.test', inviterEmail: 'boss@acme.test', role: 'staff', locale: 'es' });
    expect(i.subject).toBe('Lo invitaron a unirse a una cuenta de Recepcionista');
    expect(i.text).toContain('boss@acme.test lo invitó a unirse a una cuenta llamada “Acme” en Recepcionista como personal.');
    expect(i.text).not.toContain('evil.test');
    const en = inviteTemplate({ link: 'https://x.test/i', businessName: '', role: 'owner' });
    expect(en.text).toContain('You were invited to join an account named “a Recepcionista account” on Recepcionista as owner.');
    expect(inviteTemplate({ link: 'x', businessName: '', role: 'owner', locale: 'es' }).text).toContain('“una cuenta de Recepcionista”');
  });
});

describe('billing and usage messages', () => {
  test('billing emails by locale', () => {
    const o = { businessName: 'Acme', link: 'https://x.test/b', trialEnd: new Date('2026-12-01T00:00:00Z') };
    expect(renderBillingEmail('trial_will_end', o).text).toContain('ends on 2026-12-01.');
    const es = renderBillingEmail('trial_will_end', { ...o, locale: 'es' });
    expect(es.subject).toBe('Su prueba gratuita de Recepcionista termina pronto');
    expect(es.text).toContain('termina el 2026-12-01.');
    expect(renderBillingEmail('payment_failed', { ...o, locale: 'es' }).html).toContain('Actualizar método de pago');
  });
  test('usage warnings (email + text) by locale', () => {
    const w = { kind: 'ai', level: 100, used: 10, cap: 10, unit: 'minutes' } as const;
    expect(warningMessage(w, 'Acme').subject).toBe('Limit reached: AI call minutes (Acme)');
    const es = warningMessage(w, 'Acme', 'es');
    expect(es.subject).toBe('Límite alcanzado: minutos de llamada con IA (Acme)');
    expect(es.sms).toContain('10 de 10 minutos');
  });
  test('banner state by locale', () => {
    const b = { billing_status: 'canceled' as const, past_due_since: null, trial_ends_at: null, cancel_at_period_end: false, current_period_end: null };
    const env = { BILLING_ENFORCED: 'true' } as unknown as NodeJS.ProcessEnv;
    expect(bannerFor(b, null, true, new Date(), env)?.title).toBe('Subscription canceled');
    const es = bannerFor(b, null, false, new Date(), env, 'es');
    expect(es?.title).toBe('Suscripción cancelada');
    expect(es?.message).toContain('Pida al propietario de la cuenta que lo resuelva.');
  });
  test('call handling change line by locale', () => {
    const base = { call_mode: 'ai', forward_number_e164: null, forward_number_verified_at: null, forward_during_hours: false } as never;
    const change = { before: base, after: { ...(base as object), call_mode: 'paused' } } as never;
    expect(changeSummary(change, 'mode_changed', 'en').line).toBe('call handling changed from AI answers to paused (mode_changed)');
    expect(changeSummary(change, 'mode_changed', 'es').line).toBe('el manejo de llamadas cambió de contesta la IA a en pausa (mode_changed)');
  });
});

describe('briefing narration and readiness', () => {
  const biz = { id: 'b', name: 'Acme', owner_name: 'Ana', vertical: 'hvac', timezone: 'America/New_York', status: 'live', hours: {}, service_area: [], created_at: '' } as unknown as Business;
  const empty = { calls: [], bookings: [], flagged: [], deposits: 0, stats: { calls: 0, bookings: 0, revenue: 0, flags: 0 } } as never;
  test('the quiet-day briefing exists in English and Spanish', () => {
    expect(fallbackScript(biz, empty)).toContain('Hola Ana.');
    expect(fallbackScript(biz, empty, 'es')).toContain('Eso es todo.');
    const en = fallbackScript(biz, empty, 'en');
    expect(en.startsWith('Hi Ana.')).toBe(true);
    expect(en).toContain('That is all.');
    expect(en).not.toContain('Hoy');
  });
  test('readiness in Spanish', () => {
    expect(kbReadiness({ services: [], faqs: [] }, { hours: {} }, 'es').blockers[0].message).toMatch(/^Agregue al menos 3 servicios/);
  });
});
