/**
 * Every customer-facing message. Pure functions — no I/O, no DB, no network.
 * Bilingual by construction: a Miami shop that answers the phone in Spanish
 * has to text in Spanish too, or the confirmation reads like a different company.
 */
import { differenceInCalendarDays, format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import type { Booking, Business } from '@/lib/types';
import { DEFAULT_TIMEZONE, tzOf } from '@/lib/time';
import { formatCents } from '@/lib/money';
import { policySentence } from '@/lib/refunds';
import { packOf, tx } from '@/lib/verticals';
import { validateReviewUrl } from '@/lib/business-config';

export type Lang = 'en' | 'es' | 'mixed';

const DEFAULT_TZ = DEFAULT_TIMEZONE;

/** Hard ceiling so a long address or a wide URL can never split an SMS. */
export const SMS_LIMIT = 300;

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
function wallFormatter(tz: string): Intl.DateTimeFormat {
  let f = wallFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    wallFormatters.set(tz, f);
  }
  return f;
}

/**
 * date-fns formats in the runtime's local zone, so we first move the instant
 * onto its wall clock in the business zone. "today"/"tomorrow" then compare
 * correctly even when the server itself runs in UTC.
 */
function etWallClock(input: string | Date, tz: string = DEFAULT_TZ): Date {
  const parts = wallFormatter(tz).formatToParts(new Date(input));
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
export function formatWhen(iso: string, language: Lang = 'en', timezone?: string): string {
  const tz = tzOf(timezone);
  const when = etWallClock(iso, tz);
  const days = differenceInCalendarDays(when, etWallClock(new Date(), tz));
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
  return formatCents(cents);
}

/**
 * Caller-supplied free text (service, address, description, name) is relayed
 * by an LLM and must not become a phishing vector inside a text that carries
 * the business's name: strip links/domains and anything but plain characters,
 * and keep it short.
 */
export function safeText(raw: string | null | undefined, max = 60): string {
  return (raw ?? '')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?/gi, '')
    .replace(/[^\p{L}\p{N} .,#'&/()+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function firstName(name: string): string {
  return safeText(name, 30).split(/\s+/)[0] || 'there';
}

function clip(body: string): string {
  return body.length <= SMS_LIMIT ? body : `${body.slice(0, SMS_LIMIT - 1)}…`;
}

export interface ConfirmationArgs {
  business: Business;
  booking: Booking;
  language?: Lang;
}

/** The wording that tells a customer about follow-up texts. `followupNoticePresent` checks for it before consent is recorded. */
export const FOLLOWUP_NOTICE_RE = /(may text you after your visit|podemos escribirle despu[eé]s de su visita)/i;

export function confirmationSms({ business, booking, language = 'en' }: ConfirmationArgs): string {
  const name = firstName(booking.customer_name);
  const when = formatWhen(booking.scheduled_at, language, business.timezone);
  const addr = safeText(booking.address, 80);
  const where = addr ? `, ${addr}` : '';
  const pack = packOf(business);
  const service = safeText(booking.service) || tx(pack.sms.fallbackService, language === 'es' ? 'es' : 'en');
  const price = booking.price_estimate ? money(booking.price_estimate) : null;
  // The trade's preparation note goes in only when the whole text still fits one message: the cancel + follow-up notices are never cut for it.
  const withNote = (body: (note: string) => string, note: string | null): string => {
    const plain = body('');
    if (!note) return clip(plain);
    const full = body(` ${note}`);
    return full.length <= SMS_LIMIT ? full : clip(plain);
  };
  const note = pack.sms.confirmationNote ? tx(pack.sms.confirmationNote, language === 'es' ? 'es' : 'en') : null;

  if (language === 'es') {
    const estimate = price ? ` Aprox. ${price}.` : '';
    return withNote((n) => `${business.name}: Confirmado — ${service}, ${when}${where}.${estimate}${n} Responda C para cancelar. Podemos escribirle después de su visita. ¡Gracias ${name}!`, note);
  }
  const estimate = price ? ` Estimate ${price}.` : '';
  if (language === 'mixed') {
    return withNote((n) => `${business.name}: You're all set — ${service}, ${when}${where}.${estimate}${n} Text C to cancel. We may text you after your visit. ¡Gracias ${name}!`, note);
  }
  return withNote((n) => `${business.name}: Confirmed — ${service}, ${when}${where}.${estimate}${n} Reply C to cancel. We may text you after your visit. Thanks ${name}!`, note);
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
  const what = safeText(service) || tx(packOf(business).sms.fallbackService, language === 'es' ? 'es' : 'en');
  const lang = language === 'es' ? 'es' : 'en';
  const build = (policy: string) => {
    if (language === 'es') return `${business.name}: Depósito de ${amount} para ${what}.${policy} Enlace seguro: ${url}`;
    if (language === 'mixed') return `${business.name}: Your ${amount} deposit for ${what}.${policy} Enlace seguro: ${url}`;
    return `${business.name}: Your ${amount} deposit for ${what}.${policy} Secure link: ${url}`;
  };
  // The refund policy travels with the link; it is dropped (never the link) when it would not fit one text.
  const withPolicy = build(` ${policySentence(business.refund_policy, lang)}`);
  return clip(withPolicy.length <= SMS_LIMIT ? withPolicy : build(''));
}

export interface GratitudeArgs {
  business: Business;
  booking: Booking;
  language?: Lang;
}

export function gratitudeSms({ business, booking, language = 'en' }: GratitudeArgs): string {
  const name = firstName(booking.customer_name);
  const svc = safeText(booking.service) || tx(packOf(business).sms.fallbackService, language === 'es' ? 'es' : 'en');
  const service = svc.charAt(0).toLowerCase() + svc.slice(1);

  if (language === 'es') {
    return clip(
      `Hola ${name}, ¿cómo quedó el ${service}? Responda 1-5. — ${assistantNameOf(business)}, ${business.name}`,
    );
  }
  if (language === 'mixed') {
    return clip(
      `Hola ${name}, how did the ${service} go? Responda 1-5. — ${assistantNameOf(business)}, ${business.name}`,
    );
  }
  return clip(`Hi ${name}, how did the ${service} go? Reply 1-5. — ${assistantNameOf(business)}, ${business.name}`);
}

/** The name the assistant goes by in customer texts when the owner has not chosen one. */
export const DEFAULT_ASSISTANT_NAME = 'Maria';

/** The business's assistant name (`businesses.assistant_name`, NULL = the platform default). */
export function assistantNameOf(business: Pick<Business, 'assistant_name'>): string {
  return safeText(business.assistant_name, 40) || DEFAULT_ASSISTANT_NAME;
}

/**
 * Where a 4-5 star customer is sent: the business's OWN Google review link, or null when none is set. There is no platform or
 * environment fallback on purpose: a shared link would send every tenant's customers to somebody else's reviews.
 */
export function reviewLinkOf(business: Pick<Business, 'review_url'>): string | null {
  const v = validateReviewUrl(business.review_url ?? null);
  return v.ok ? v.value : null;
}

export interface ReviewRequestArgs {
  business: Business;
  booking: Booking;
  /** The business's review link (`reviewLinkOf`); null/empty = no link: the text only says thanks. */
  reviewUrl?: string | null;
  language?: Lang;
}

/** Room for ". Reply STOP to opt out" (the footer the send path adds) inside the 300-character text. */
const REVIEW_BODY_MAX = SMS_LIMIT - 26;

export function reviewRequestSms({ business, booking, reviewUrl, language = 'en' }: ReviewRequestArgs): string {
  const name = firstName(booking.customer_name);
  const who = `${assistantNameOf(business)}, ${business.name}`;
  const link = reviewUrl?.trim() || null;
  const es = language === 'es';
  if (!link) {
    return clip(es ? `¡Gracias ${name}! Nos alegra que le haya ido bien. — ${who}` : `Thank you ${name}! We are glad it went well. ¡Gracias! — ${who}`);
  }
  // The link is never cut: when the text is too long the words AROUND it shrink (the signature, then the greeting), in this order.
  const tiers = es
    ? [`¡Gracias ${name}! ¿Nos deja una reseña de 30 segundos? ${link} — ${who}`, `¡Gracias ${name}! ¿Una reseña de 30 segundos? ${link} — ${business.name}`, `¡Gracias! Reseña: ${link} — ${business.name}`]
    : [`Thank you ${name}! 30 seconds for a quick review? ${link} ¡Gracias! — ${who}`, `Thank you ${name}! Quick review? ${link} — ${business.name}`, `Thank you! Review: ${link} — ${business.name}`];
  const fit = tiers.find((t) => [...t].length <= REVIEW_BODY_MAX);
  if (fit) return fit;
  // Even the shortest wording does not fit (a very long business name or a legacy link): the text without the link, never a cut one.
  return clip(es ? `¡Gracias ${name}! Nos alegra que le haya ido bien. — ${business.name}` : `Thank you ${name}! We are glad it went well. — ${business.name}`);
}

export interface OwnerEscalationArgs {
  business: Business;
  customer: string;
  reason: string;
}

/** Owner-facing: Spanglish on purpose, this is Jorge reading it in his truck. */
export function ownerEscalationSms({ business, customer, reason }: OwnerEscalationArgs): string {
  return clip(
    `${business.name}: ${safeText(customer, 40)} — "${safeText(reason, 120)}". Cliente no está contento / unhappy customer, llámalo hoy. Do not ask them for a review.`,
  );
}

export interface OwnerAlertArgs {
  business: Business;
  text: string;
}

export function ownerAlertSms({ business, text }: OwnerAlertArgs): string {
  return clip(`${business.name}: ${text}`);
}

// ---- booking changes (reschedule, cancellation, refund): transactional texts about a booking the customer already has ----

/** "Sat, Dec 5 at 9:00 AM" in the BUSINESS zone: an explicit date, because a moved appointment must never be ambiguous. */
export function formatWhenFull(iso: string, language: Lang = 'en', timezone?: string): string {
  const tz = tzOf(timezone);
  const spanish = language === 'es';
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat(spanish ? 'es-US' : 'en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  return spanish ? `${date}, ${time}` : `${date} at ${time}`;
}

export interface RescheduleSmsArgs { business: Business; booking: Booking; language?: Lang }

/** The customer's appointment was moved (by the owner or by the customer on the phone). */
export function rescheduleSms({ business, booking, language = 'en' }: RescheduleSmsArgs): string {
  const name = firstName(booking.customer_name);
  const when = formatWhenFull(booking.scheduled_at, language, business.timezone);
  const service = safeText(booking.service) || tx(packOf(business).sms.fallbackService, language === 'es' ? 'es' : 'en');
  const addr = safeText(booking.address, 80);
  const where = addr ? `, ${addr}` : '';
  if (language === 'es') return clip(`${business.name}: Su cita (${service}) se cambió a ${when}${where}. Si no le funciona, llámenos. Gracias ${name}.`);
  if (language === 'mixed') return clip(`${business.name}: Your ${service} moved to ${when}${where}. Si no le funciona, call us. Gracias ${name}.`);
  return clip(`${business.name}: Your ${service} was moved to ${when}${where}. If that does not work, call us. Thanks ${name}.`);
}

export interface CancelSmsArgs {
  business: Business;
  booking: Booking;
  language?: Lang;
  /** What the refund policy says about the PAID deposit of this cancellation: 'none' = no deposit paid. Never promises a refund the owner has not issued. */
  deposit?: { state: 'none' } | { state: 'refundable' | 'not_refundable'; amount_cents: number };
}

export function cancelSms({ business, booking, language = 'en', deposit = { state: 'none' } }: CancelSmsArgs): string {
  const when = formatWhenFull(booking.scheduled_at, language, business.timezone);
  const service = safeText(booking.service) || tx(packOf(business).sms.fallbackService, language === 'es' ? 'es' : 'en');
  const spanish = language === 'es';
  let tail = '';
  if (deposit.state === 'refundable') {
    tail = spanish ? ` Su depósito de ${money(deposit.amount_cents)} es reembolsable; lo procesaremos.` : ` Your ${money(deposit.amount_cents)} deposit is eligible for a refund; we will process it.`;
  } else if (deposit.state === 'not_refundable') {
    tail = spanish ? ` Según nuestra política, el depósito de ${money(deposit.amount_cents)} no es reembolsable. Llámenos si tiene dudas.` : ` Under our policy the ${money(deposit.amount_cents)} deposit is not refunded. Call us with any questions.`;
  }
  if (spanish) return clip(`${business.name}: Su cita (${service}, ${when}) fue cancelada.${tail}`);
  return clip(`${business.name}: Your ${service} on ${when} was cancelled.${tail}`);
}

export interface RefundSmsArgs { business: Business; amount_cents: number; language?: Lang }

/** A refund was issued. Banks take days to show it, so say that rather than "refunded instantly". */
export function refundSms({ business, amount_cents, language = 'en' }: RefundSmsArgs): string {
  if (language === 'es') return clip(`${business.name}: Le reembolsamos ${money(amount_cents)} de su depósito. Su banco puede tardar 5-10 días hábiles en mostrarlo.`);
  return clip(`${business.name}: We refunded ${money(amount_cents)} of your deposit. It can take 5-10 business days to show on your statement.`);
}
