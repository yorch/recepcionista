/**
 * Wording of the inbox side of messaging (pure: no I/O). The auto-reply goes to a CUSTOMER, in the language they wrote in (else the
 * business's default language), signed by the assistant's name and naming the trade's own word for a visit. The forward goes to the
 * OWNER and never carries a link a stranger typed.
 */
import { assistantNameOf } from '@/lib/messaging/templates';
import { packOf, tx } from '@/lib/verticals';
import { formatPhoneDisplay } from '@/lib/i18n/core';
import type { Business } from '@/lib/types';

export type InboxLang = 'en' | 'es';

/** Spanish words that make a short text clearly Spanish; accents/inverted marks also count. A coin flip falls back to the business's language. */
const ES_HINT = /(?:[áéíóúñ¿¡])|\b(hola|buenas|buenos|gracias|necesito|quiero|puede|pueden|puedo|cuando|cuándo|cuanto|cuánto|favor|por favor|mañana|tarde|noche|cita|ayuda|llamar|llame|tengo|estoy|donde|dónde|casa|aire|agua)\b/i;
const EN_HINT = /\b(the|and|can|could|you|when|what|please|thanks|thank|need|want|will|are|is|my|your|hello|hi)\b/i;

/** The language to answer in: what the customer wrote, else the business's `locale_default`. */
export function inboxLanguage(business: Pick<Business, 'locale_default'>, body: string): InboxLang {
  const es = ES_HINT.test(body);
  const en = EN_HINT.test(body);
  if (es && !en) return 'es';
  if (en && !es) return 'en';
  return business.locale_default === 'es' ? 'es' : 'en';
}

const SMS_MAX = 300;
const clip = (s: string): string => (s.length <= SMS_MAX ? s : `${s.slice(0, SMS_MAX - 1)}…`);

/** One-time acknowledgement. The STOP footer is added by the send path (it is a customer-facing text). */
export function autoReplyText(business: Business, body: string): string {
  const lang = inboxLanguage(business, body);
  const assistant = assistantNameOf(business);
  const service = tx(packOf(business).sms.fallbackService, lang);
  const phone = business.phone ? formatPhoneDisplay(business.phone) : '';
  if (lang === 'es') {
    const call = phone ? ` Para pedir ${service === 'cita' ? 'una cita' : `una ${service}`} o si es urgente, llame al ${phone}.` : ' Si es urgente, llámenos.';
    return clip(`${business.name}: Hola, le habla ${assistant}, la asistente. Recibimos su mensaje y el equipo lo verá.${call}`);
  }
  const call = phone ? ` To book a ${service} or if it is urgent, call ${phone}.` : ' If it is urgent, please call us.';
  return clip(`${business.name}: Hi, this is ${assistant}, the assistant. We got your message and the team will see it.${call}`);
}

/**
 * Anything a phone would turn into a tappable link: a scheme or www. link, a bare domain with an optional path (`evil.com/login`, `bit.ly/x`),
 * or a bare IPv4 address. A stranger's text must never arrive on the owner's phone, from the number the owner trusts, as a clickable link.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/\S*)?/gi;

/** What the owner is texted when a customer writes in (the full text stays in the dashboard inbox). */
export function ownerForwardText(business: Pick<Business, 'locale_default'>, from: { last4: string }, body: string, opts: { possibleOptOut?: boolean } = {}): string {
  const quoted = safeForward(body, 140);
  if (business.locale_default === 'es') {
    return `${opts.possibleOptOut ? 'Posible baja: ' : ''}Mensaje de un cliente (...${from.last4}): "${quoted}". ${opts.possibleOptOut ? 'No se le respondio solo: revise Mensajes. ' : ''}Responda desde Mensajes en el panel.`;
  }
  return `${opts.possibleOptOut ? 'Possible opt-out: ' : ''}Customer text (...${from.last4}): "${quoted}". ${opts.possibleOptOut ? 'No automatic reply was sent: check Messages. ' : ''}Reply from Messages in the dashboard.`;
}

/**
 * What the sms_log row of the owner forward keeps: NOT the customer's words (they live only in the inbox row, so erasing or exporting the customer
 * covers every copy). `revocation` marks a text that may be an opt-out request.
 */
export function ownerForwardLogText(business: Pick<Business, 'locale_default'>, from: { last4: string }): string {
  if (business.locale_default === 'es') return `Mensaje de un cliente (...${from.last4}) reenviado al propietario. El texto solo se conserva en Mensajes.`;
  return `Customer text (...${from.last4}) forwarded to the owner. The words are kept only in Messages.`;
}

/** Links typed by a stranger are replaced (the owner opens the dashboard for the original), whitespace collapsed, length capped. */
export function safeForward(body: string, max: number): string {
  const one = (body ?? '').replace(URL_RE, '[link]').replace(/\s+/g, ' ').trim();
  const cut = one.length <= max ? one : `${one.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
  return cut.replace(/"/g, "'");
}

export { MANUAL_TEXT_MAX } from '@/lib/messaging/manual-limits';
