/**
 * Every customer-facing message. Pure functions — no I/O, no DB.
 * Bilingual by construction: a template that can address a Miami customer must
 * be able to do it in the language they actually called in.
 */
import type { Booking, Business } from '@/lib/types';

export type Lang = 'en' | 'es' | 'mixed';

const TZ = 'America/New_York';
export const SMS_LIMIT = 300;

/** "today at 2:00 PM" / "sábado a las 9:00 AM" */
export function formatWhen(iso: string, lang: Lang = 'en'): string {
  const d = new Date(iso);
  const now = new Date();
  const fmtDay = (x: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(x);
  const dayEt = fmtDay(d);
  const todayEt = fmtDay(now);
  const tomorrowEt = fmtDay(new Date(now.getTime() + 86400000));

  const time = new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
  }).format(d);

  if (dayEt === todayEt) return lang === 'es' ? `hoy a las ${time}` : `today at ${time}`;
  if (dayEt === tomorrowEt) return lang === 'es' ? `mañana a las ${time}` : `tomorrow at ${time}`;

  const weekday = new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long', timeZone: TZ,
  }).format(d);
  return lang === 'es' ? `el ${weekday} a las ${time}` : `${weekday} at ${time}`;
}

export function money(amount?: number | null): string {
  if (amount == null) return '';
  return `$${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function clip(body: string): string {
  return body.length <= SMS_LIMIT ? body : `${body.slice(0, SMS_LIMIT - 1)}…`;
}

/** A customer who called in Spanish gets Spanish. Mixed callers get the warm hybrid. */
function isEs(lang: Lang): boolean {
  return lang === 'es';
}

export function confirmationSms({
  business, booking, language = 'en',
}: { business: Business; booking: Booking; language?: Lang }): string {
  const when = formatWhen(booking.scheduled_at, language);
  const price = booking.price_estimate ? ` ${money(booking.price_estimate)}.` : '.';
  const name = booking.customer_name.split(' ')[0];
  const addr = booking.address ? `, ${booking.address}` : '';

  if (isEs(language)) {
    return clip(
      `${business.name}: Confirmado — ${booking.service}, ${when}${addr}.${price} Responda C para cancelar. ¡Gracias ${name}!`,
    );
  }
  if (language === 'mixed') {
    return clip(
      `${business.name}: You're all set — ${booking.service}, ${when}${addr}.${price} Text C to cancel. ¡Gracias ${name}!`,
    );
  }
  return clip(
    `${business.name}: Confirmed — ${booking.service}, ${when}${addr}.${price} Reply C to cancel. Thanks ${name}!`,
  );
}

export function paymentLinkSms({
  business, amount_cents, url, service, language = 'en',
}: {
  business: Business; amount_cents: number; url: string;
  service?: string; language?: Lang;
}): string {
  const amount = money(amount_cents / 100);
  const what = service ? `${service} — ` : '';
  if (isEs(language)) {
    return clip(
      `${business.name}: Depósito de emergencia ${amount} para ${what}su servicio de hoy. Enlace seguro: ${url}`,
    );
  }
  return clip(
    `${business.name}: Emergency deposit ${amount} for ${what}today's visit. Secure link: ${url}`,
  );
}

export function gratitudeSms({
  business, booking, language = 'en',
}: { business: Business; booking: Booking; language?: Lang }): string {
  const name = booking.customer_name.split(' ')[0];
  if (isEs(language)) {
    return clip(
      `Hola ${name}, ¿cómo quedó su ${booking.service}? Responda 1-5. — ${business.name}`,
    );
  }
  return clip(
    `Hi ${name}, how did the ${booking.service} go? Reply 1-5. — ${business.name}`,
  );
}

export function reviewRequestSms({
  business, booking, reviewUrl,
}: { business: Business; booking: Booking; reviewUrl: string }): string {
  const name = booking.customer_name.split(' ')[0];
  return clip(
    `Thank you ${name}! If you have 30 seconds, a review helps our small shop more than you know: ${reviewUrl} — ${business.name}`,
  );
}

export function ownerEscalationSms({
  business, customer, reason,
}: { business: Business; customer: string; reason: string }): string {
  return clip(
    `${business.name}: ${customer} reported a problem — "${reason}". They are waiting on you. Call them back tonight.`,
  );
}

export function ownerAlertSms({
  business, text,
}: { business: Business; text: string }): string {
  return clip(`${business.name}: ${text}`);
}

export function reviewUrl(): string {
  return process.env.REVIEW_URL || 'https://g.page/r/demo/review';
}
