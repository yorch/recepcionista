/**
 * Every customer-facing message. Pure functions — no I/O, no DB, no network.
 * Bilingual by construction: a Miami shop that answers the phone in Spanish
 * has to text in Spanish too, or the confirmation reads like a different company.
 */
import { differenceInCalendarDays, format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import type { Booking, Business } from '@/lib/types';

export type Lang = 'en' | 'es' | 'mixed';

const TZ = 'America/New_York';

/** Hard ceiling so a long address or a wide URL can never split an SMS. */
export const SMS_LIMIT = 300;

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * date-fns formats in the runtime's local zone, so we first move the instant
 * onto its America/New_York wall clock. "today"/"tomorrow" then compare
 * correctly even when the server itself runs in UTC.
 */
function etWallClock(input: string | Date): Date {
  const parts = etParts.formatToParts(new Date(input));
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour') % 24, // Intl renders midnight as "24" in some ICU builds
    pick('minute'),
  );
}

/** "today at 2:00 PM" / "tomorrow at 9:00 AM" / "Saturday at 9:00 AM" */
export function formatWhen(iso: string, language: Lang = 'en'): string {
  const when = etWallClock(iso);
  const days = differenceInCalendarDays(when, etWallClock(new Date()));
  const time = format(when, 'h:mm a');
  const spanish = language === 'es';

  if (days === 0) return spanish ? `hoy a las ${time}` : `today at ${time}`;
  if (days === 1) return spanish ? `mañana a las ${time}` : `tomorrow at ${time}`;
  if (days === -1) return spanish ? `ayer a las ${time}` : `yesterday at ${time}`;

  const weekday = format(when, 'EEEE', spanish ? { locale: esLocale } : undefined);
  return spanish ? `el ${weekday} a las ${time}` : `${weekday} at ${time}`;
}

/** "$189" — cents in, human money out. */
export function money(cents: number): string {
  const dollars = Math.round(cents) / 100;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'there';
}

function clip(body: string): string {
  return body.length <= SMS_LIMIT ? body : `${body.slice(0, SMS_LIMIT - 1)}…`;
}

export interface ConfirmationArgs {
  business: Business;
  booking: Booking;
  language?: Lang;
}

export function confirmationSms({ business, booking, language = 'en' }: ConfirmationArgs): string {
  const name = firstName(booking.customer_name);
  const when = formatWhen(booking.scheduled_at, language);
  const where = booking.address ? `, ${booking.address}` : '';
  const price = booking.price_estimate ? money(booking.price_estimate * 100) : null;

  if (language === 'es') {
    const estimate = price ? ` Aprox. ${price}.` : '';
    return clip(
      `${business.name}: Confirmado — ${booking.service}, ${when}${where}.${estimate} Responda C para cancelar. ¡Gracias ${name}!`,
    );
  }
  const estimate = price ? ` Estimate ${price}.` : '';
  if (language === 'mixed') {
    return clip(
      `${business.name}: You're all set — ${booking.service}, ${when}${where}.${estimate} Text C to cancel. ¡Gracias ${name}!`,
    );
  }
  return clip(
    `${business.name}: Confirmed — ${booking.service}, ${when}${where}.${estimate} Reply C to cancel. Thanks ${name}!`,
  );
}

export interface PaymentLinkArgs {
  business: Business;
  amount_cents: number;
  url: string;
  service?: string;
  language?: Lang;
}

export function paymentLinkSms({
  business, amount_cents, url, service, language = 'en',
}: PaymentLinkArgs): string {
  const amount = money(amount_cents);
  const what = service?.trim() || 'service';

  if (language === 'es') {
    return clip(
      `${business.name}: Depósito de ${amount} para ${what}. Enlace seguro: ${url}`,
    );
  }
  if (language === 'mixed') {
    return clip(
      `${business.name}: Your ${amount} deposit for ${what}. Enlace seguro: ${url}`,
    );
  }
  return clip(
    `${business.name}: Your ${amount} deposit for ${what}. Secure link: ${url}`,
  );
}

export interface GratitudeArgs {
  business: Business;
  booking: Booking;
  language?: Lang;
}

export function gratitudeSms({ business, booking, language = 'en' }: GratitudeArgs): string {
  const name = firstName(booking.customer_name);
  const service = booking.service.charAt(0).toLowerCase() + booking.service.slice(1);

  if (language === 'es') {
    return clip(
      `Hola ${name}, ¿cómo quedó el ${service}? Responda 1-5. — ${business.name}`,
    );
  }
  if (language === 'mixed') {
    return clip(
      `Hola ${name}, how did the ${service} go? Responda 1-5. — ${business.name}`,
    );
  }
  return clip(`Hi ${name}, how did the ${service} go? Reply 1-5. — ${business.name}`);
}

/** Where a 4–5 star customer is sent. Overridable per deployment. */
export function reviewUrl(): string {
  return process.env.REVIEW_URL || 'https://g.page/r/demo/review';
}

export interface ReviewRequestArgs {
  business: Business;
  booking: Booking;
  reviewUrl: string;
}

export function reviewRequestSms({ business, booking, reviewUrl }: ReviewRequestArgs): string {
  const name = firstName(booking.customer_name);
  return clip(
    `Thank you ${name}! 30 seconds for a quick review? ${reviewUrl} ¡Gracias! — ${business.name}`,
  );
}

export interface OwnerEscalationArgs {
  business: Business;
  customer: string;
  reason: string;
}

/** Owner-facing: Spanglish on purpose, this is Jorge reading it in his truck. */
export function ownerEscalationSms({ business, customer, reason }: OwnerEscalationArgs): string {
  return clip(
    `${business.name}: ${customer} — "${reason}". Cliente no está contento / unhappy customer, llámalo hoy. Do not ask them for a review.`,
  );
}

export interface OwnerAlertArgs {
  business: Business;
  text: string;
}

export function ownerAlertSms({ business, text }: OwnerAlertArgs): string {
  return clip(`${business.name}: ${text}`);
}
