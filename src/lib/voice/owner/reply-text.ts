/**
 * Pure helpers for the owner voice reply channel: validating the message the owner dictated, building the text the CUSTOMER gets and the
 * confirmation text the OWNER gets, short structured lead lines, and reading a spoken lead reference. No I/O.
 *
 * Everything the model supplies is data: the message is scanned (no links, emails, phone numbers, digit codes, payment requests, instruction-like text),
 * names are cut down to one plain word, and a lead is described only by fields the server derived (kind, first name, last 4 digits, time).
 */
import crypto from 'node:crypto';
import { ownerTextProblem, type OwnerTextProblem } from '@/lib/kb-patch';
import { clampAlertBody } from '@/lib/voice/owner-alert';
import { smsSegments, STOP_FOOTER, withStopFooter } from '@/lib/messaging/policy';
import { localDateKey, addDaysToDateKey } from '@/lib/time';
import { OWNER_REPLY_LEADS_SHOWN, OWNER_REPLY_MAX_CHARS, OWNER_REPLY_MAX_SEGMENTS } from './reply-config';

type Lang = 'en' | 'es';
const say = (lang: Lang, en: string, es: string): string => (lang === 'es' ? es : en);

// ---------------------------------------------------------------------------------------------------------------- the message

export type ReplyBodyProblem = OwnerTextProblem | 'digits' | 'payment' | 'symbols' | 'too_long_sms';

const SMART: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '–': '-', '—': '-', ' ': ' ' };
/** Digit runs that look like a code, account or phone number (a clock time "3:30" or a price "$99" is fine). */
const DIGIT_RES: RegExp[] = [/\d{5,}/, /\d{3}[\s-]\d{3}\b/, /\b(?:\d[\s.,-]*){8,}\b/];
/** Asking the customer to pay / send / read out something: the phishing shapes. A relay of the owner's words must not become one. */
const PAYMENT_RE = /\b(?:gift ?cards?|wire|wiring|western union|money ?gram|venmo|zelle|cash ?app|paypal|bitcoin|crypto|bank|routing|account number|verification code|security code|one[- ]time|otp|tarjeta de regalo|giro|transferencia|cuenta bancaria|codigo de verificacion|código de verificación)\b/i;
/** Only letters, digits, spaces and plain punctuation: no emoji, markup, brackets or other symbols. */
const SYMBOL_RE = /[^\p{L}\p{N}\p{M}\s.,;:!?'"()\-/&%$+*¿¡]/u;

export type ReplyBody = { ok: true; body: string } | { ok: false; problem: ReplyBodyProblem; flagged: boolean };

/** Normalise one dictated message to a single plain line. */
export function normalizeReplyBody(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return s.replace(/[‘’“”…–— ]/g, (c) => SMART[c] ?? c).replace(/\s+/g, ' ').trim();
}

/**
 * `flagged` = looks like an attack on the assistant (instruction text, role markers, tool names), as opposed to something an honest owner might
 * say but may not relay (a phone number, a link): those are refused without a strike.
 */
export function validateReplyBody(raw: unknown): ReplyBody {
  const body = normalizeReplyBody(raw);
  const problem = ownerTextProblem(body, OWNER_REPLY_MAX_CHARS);
  if (problem) return { ok: false, problem, flagged: problem === 'injection' || problem === 'tool_name' || problem === 'control' };
  if (body.includes('@') || body.includes('#')) return { ok: false, problem: 'url', flagged: false };
  if (DIGIT_RES.some((re) => re.test(body))) return { ok: false, problem: 'digits', flagged: false };
  if (PAYMENT_RE.test(body)) return { ok: false, problem: 'payment', flagged: false };
  if (SYMBOL_RE.test(body)) return { ok: false, problem: 'symbols', flagged: false };
  return { ok: true, body };
}

export function bodyProblemMessage(problem: ReplyBodyProblem, lang: Lang): string {
  switch (problem) {
    case 'empty': return say(lang, 'I need the words you want to send.', 'Necesito las palabras que desea enviar.');
    case 'too_long': return say(lang, `That is too long for a text. Please keep it under ${OWNER_REPLY_MAX_CHARS} characters.`, `Es demasiado largo para un mensaje. Por favor use menos de ${OWNER_REPLY_MAX_CHARS} caracteres.`);
    case 'too_long_sms': return say(lang, 'That would take too many text segments once the business name and opt-out line are added. Please shorten it.', 'Ocuparía demasiados mensajes con el nombre del negocio y la línea de baja. Por favor acórtelo.');
    case 'url': return say(lang, 'I cannot send web addresses or email addresses in a text from the phone line.', 'No puedo enviar direcciones web ni correos en un mensaje desde la línea telefónica.');
    case 'phone': case 'digits': return say(lang, 'I cannot send phone numbers or long numbers in a text from the phone line. The customer already has the business number.', 'No puedo enviar números de teléfono ni números largos en un mensaje desde la línea telefónica. El cliente ya tiene el número del negocio.');
    case 'payment': return say(lang, 'I cannot send messages about payments, bank details or verification codes from the phone line. Use the dashboard.', 'No puedo enviar mensajes sobre pagos, datos bancarios o códigos de verificación desde la línea telefónica. Use el panel.');
    case 'symbols': return say(lang, 'Please use plain words only, without emoji or special symbols.', 'Por favor use solo palabras sencillas, sin emojis ni símbolos especiales.');
    default: return say(lang, 'I cannot send that wording from the phone line. Please say it differently or use the dashboard.', 'No puedo enviar esa redacción desde la línea telefónica. Dígalo de otra forma o use el panel.');
  }
}

// ---------------------------------------------------------------------------------------------------------------- the customer's text

const clip = (s: string, n: number): string => { const cps = [...s]; return cps.length <= n ? s : `${cps.slice(0, n - 3).join('').trimEnd()}...`; };

export type CustomerText = { ok: true; text: string; segments: number } | { ok: false };

/**
 * What the customer receives: "<Business>: <message>. Reply STOP to opt out". The owner approved the message itself; the business name is the
 * usual identification and the footer the usual opt-out line. A message that would have to be cut to fit is refused (never silently trimmed).
 */
export function customerReplyText(businessName: string, body: string): CustomerText {
  const base = `${clip(businessName.replace(/\s+/g, ' ').trim() || 'Business', 40)}: ${body}`;
  const text = withStopFooter(base, 320, OWNER_REPLY_MAX_SEGMENTS);
  const expected = `${base.replace(/\s+$/, '').replace(/[.!]$/, '')}. ${STOP_FOOTER}`;
  if (text !== expected) return { ok: false };
  const segments = smsSegments(text);
  return segments <= OWNER_REPLY_MAX_SEGMENTS ? { ok: true, text, segments } : { ok: false };
}

// ---------------------------------------------------------------------------------------------------------------- owner texts

/** The first word of a name, letters only (<= 20): what the assistant may say aloud. Null when there is nothing safe to say. */
export function firstNameOf(name: string | null | undefined): string | null {
  const token = (name ?? '').normalize('NFC').trim().split(/\s+/)[0] ?? '';
  const clean = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (/[^\p{L}'-]/u.test(clean)) return null; // markup, digits or symbols inside the word: not a name
  if (clean.length < 2 || clean.length > 20) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

export const last4Of = (e164: string): string => e164.replace(/\D/g, '').slice(-4);

/** The confirmation text to the owner's phone. Shows the message EXACTLY as it will be sent (it must fit unclipped). */
export function ownerReplyConfirmSms(lang: Lang, o: { name: string | null; last4: string; body: string; code: string; callAt?: string }): string {
  const who = o.name ? `${o.name} (...${o.last4})` : `...${o.last4}`;
  const from = o.callAt ? say(lang, ` Call at ${o.callAt}. Not you? Reply NO.`, ` Llamada a las ${o.callAt}. No fue usted? Responda NO.`) : '';
  return say(lang,
    `Reply YES ${o.code} to text ${who}: "${o.body}". NO ${o.code} cancels. Cannot be undone once sent. Expires in 30 min.${from}`,
    `Responda SI ${o.code} para enviar a ${who}: "${o.body}". NO ${o.code} cancela. No se deshace al enviarse. Vence en 30 min.${from}`);
}

/** True when the owner alert pipeline would deliver `text` without cutting it (so the owner really sees the whole message they are approving). */
export function ownerTextFits(text: string): boolean {
  const out = clampAlertBody(text);
  return out === text.trim() || !out.endsWith('...');
}

// ---------------------------------------------------------------------------------------------------------------- leads

export type LeadKind = 'emergency' | 'handoff' | 'missed' | 'voicemail' | 'call' | 'booking';

const KIND_WORD: Record<LeadKind, [string, string]> = {
  emergency: ['an emergency call', 'una llamada de emergencia'],
  handoff: ['a call handed to you', 'una llamada transferida a usted'],
  missed: ['a missed call', 'una llamada perdida'],
  voicemail: ['a voicemail', 'un mensaje de voz'],
  call: ['a call', 'una llamada'],
  booking: ['a booking', 'una cita'],
};

/** "today around 3:12 PM" / "yesterday" / "3 days ago": the day in the business time zone. */
export function whenWords(lang: Lang, at: Date, now: Date, tz: string, clock: string): string {
  const today = localDateKey(now, tz), day = localDateKey(at, tz);
  if (day === today) return say(lang, `today around ${clock}`, `hoy a eso de las ${clock}`);
  if (day === addDaysToDateKey(today, -1)) return say(lang, `yesterday around ${clock}`, `ayer a eso de las ${clock}`);
  const days = Math.max(2, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000));
  return say(lang, `${days} days ago`, `hace ${days} días`);
}

export interface LeadLine { n: number; kind: LeadKind; name: string | null; last4: string; at: Date; textable: boolean }

/** One short structured line per lead. No customer free text, number beyond the last 4 digits, or address ever appears. */
export function leadLine(lang: Lang, l: LeadLine, now: Date, tz: string, clock: string): string {
  const who = l.name ? say(lang, `${l.name}, number ending ${l.last4}`, `${l.name}, número que termina en ${l.last4}`) : say(lang, `a number ending ${l.last4}`, `un número que termina en ${l.last4}`);
  const kind = say(lang, KIND_WORD[l.kind][0], KIND_WORD[l.kind][1]);
  const note = l.textable ? '' : say(lang, ', who asked not to be texted', ', quien pidió no recibir mensajes');
  return say(lang, `Number ${l.n}: ${kind} from ${who}, ${whenWords(lang, l.at, now, tz, clock)}${note}.`, `Número ${l.n}: ${kind} de ${who}, ${whenWords(lang, l.at, now, tz, clock)}${note}.`);
}

/** "3", "#3", "number 3", 3 -> 3 (1..OWNER_REPLY_LEADS_SHOWN). Anything else is not a reference the server issued. */
export function parseLeadRef(raw: unknown): number | null {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const m = /^(?:#|no\.?|number|numero|número|lead|ref)?\s*#?\s*(\d{1,2})$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= OWNER_REPLY_LEADS_SHOWN ? n : null;
}

/** Stable short hash for markers that must not hold a phone number in clear (processed_events ids). */
export const markerHash = (businessId: string, e164: string): string => crypto.createHash('sha256').update(`owner-lead|${businessId}|${e164}`).digest('hex').slice(0, 24);
