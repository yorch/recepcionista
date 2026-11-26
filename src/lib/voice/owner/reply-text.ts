/**
 * Pure helpers for the owner voice reply channel: validating the message the owner dictated, building the text the CUSTOMER gets and the
 * confirmation text the OWNER gets, short structured lead lines, and reading a spoken lead reference. No I/O.
 *
 * Everything the model supplies is data: the message is scanned (no links, emails, phone numbers, digit codes, payment requests, instruction-like text),
 * names are cut down to one plain word, and a lead is described only by fields the server derived (kind, first name, last 4 digits, time).
 */
import { ownerTextProblem, type OwnerTextProblem } from '@/lib/kb-patch';
import { clampAlertBody } from '@/lib/voice/owner-alert';
import { smsSegments, STOP_FOOTER, withStopFooter } from '@/lib/messaging/policy';
import { localDateKey, addDaysToDateKey } from '@/lib/time';
import { OWNER_REPLY_LEADS_SHOWN, OWNER_REPLY_MAX_CHARS, OWNER_REPLY_MAX_SEGMENTS } from './reply-config';

type Lang = 'en' | 'es';
const say = (lang: Lang, en: string, es: string): string => (lang === 'es' ? es : en);

// ---------------------------------------------------------------------------------------------------------------- the message

export type ReplyBodyProblem = OwnerTextProblem | 'digits' | 'payment' | 'symbols' | 'too_long_sms';

const SMART: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '–': '-', '—': '-', ' ': ' ' };
/**
 * Digit runs that look like a code, account or phone number (a clock time "3:30" or a price "$99" is fine). Run on text whose digits are all ASCII
 * (see foldDigits) and with spelled-out digits turned into digits (see spellToDigits). Separators: space . , - / ( ).
 */
const DIGIT_RES: RegExp[] = [/\d{5,}/, /\d{3}[\s\-./)(]+\d{3}\b/, /\b(?:\d[\s.,\-()]*){8,}\b/];
/** Toll-free numbers written with letters ("1-800-FLOWERS", "800-FLOWERS", "1 800 FLOWERS") and "555-CALL" shapes. */
const VANITY_RES: RegExp[] = [
  /\b1[\s.\-()]*8(?:00|33|44|55|66|77|88)\b/i, /\b\(?8(?:00|33|44|55|66|77|88)\)?[\s.\-]+[a-z]{4,}\b/i, /\b\d{3}[\s.\-]+[A-Z]{4,}\b/,
];
/** A link or short link spelled out ("example dot com slash pay", "bitly/abc"). */
const LINKWORD_RES: RegExp[] = [
  /\b(?:dot|punto)\s+(?:com|net|org|io|co|me|us|app|ly|info|biz|link|xyz|shop|online|site|store|click|mx|es)\b/i, /\b(?:slash|barra)\b/i,
  /\b(?:bit\s*\.?\s*ly|tiny\s*url|goo\s*\.?\s*gl|ow\s*\.?\s*ly|cutt\s*\.?\s*ly|rb\s*\.?\s*gy|is\s*\.?\s*gd|short\s*url|t\s*\.\s*co|l\s*\.\s*ink)\b/i,
  /\bh\s*t\s*t\s*p\s*s?\s*:/i, /\bw\s*w\s*w\s*\./i, /\bat\s+(?:the\s+)?(?:gmail|yahoo|outlook|hotmail|icloud)\b/i,
];
/** Asking the customer to pay / send / read out something: the phishing shapes. A relay of the owner's words must not become one. */
const PAYMENT_RE = /\b(?:gift ?cards?|wire|wiring|western union|money ?gram|venmo|zelle|cash ?app|paypal|bitcoin|crypto|bank|routing|account number|verification code|security code|one[- ]time|otp|apple ?pay|google ?pay|samsung ?pay|ssn|social security|log ?in|sign ?in|pass ?words?|pass ?codes?|pin|cvv|cvc|card (?:number|details|info(?:rmation)?|on file)|credit card|debit card|deposit link|payment link|pay(?:ing)? (?:online|link|now)|tarjeta de regalo|tarjeta de cr[eé]dito|tarjeta de d[eé]bito|n[uú]mero de tarjeta|giro|transferencia|cuenta bancaria|contrase[nñ]a|seguro social|inicio de sesi[oó]n|enlace de pago|codigo de verificacion|c[oó]digo de verificaci[oó]n)\b/i;
/** The same brands with every space and symbol removed ("Zel le", "C a s h A p p", "g.i.f.t c4rd"): distinctive terms only, so no word-in-word false hits. */
const PAYMENT_SQUASHED: string[] = [
  'giftcard', 'westernunion', 'moneygram', 'cashapp', 'zelle', 'venmo', 'paypal', 'bitcoin', 'cryptocurrency', 'applepay', 'googlepay', 'samsungpay',
  'routingnumber', 'accountnumber', 'verificationcode', 'securitycode', 'cardnumber', 'carddetails', 'creditcard', 'debitcard', 'onetimecode', 'socialsecurity',
  'depositlink', 'paymentlink', 'tarjetaderegalo', 'numerodetarjeta', 'enlacedepago', 'codigodeverificacion',
];
/** Only letters, digits, spaces and plain punctuation: no emoji, markup, brackets or other symbols. */
const SYMBOL_RE = /[^\p{L}\p{N}\p{M}\s.,;:!?'"()\-/&%$+*¿¡]/u;
/** Letters of any script other than Latin (Cyrillic or Greek look-alikes of Latin letters): refused outright. */
const NON_LATIN_LETTER_RE = /(?!\p{Script=Latin})\p{L}/u;

const SPELLED: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};
const SPELLED_RE = new RegExp(`\\b(?:${Object.keys(SPELLED).join('|')})\\b`, 'gi');

/** Every Unicode decimal digit (full-width, Arabic-Indic, Devanagari, mathematical, ...) as its ASCII digit. */
export function foldDigits(text: string): string {
  const isNd = (cp: number): boolean => cp >= 0 && /\p{Nd}/u.test(String.fromCodePoint(cp));
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 128 || !isNd(cp)) { out += ch; continue; }
    let n = 0;
    while (isNd(cp - 1 - n)) n++; // decimal digit blocks come in aligned runs of ten, each starting at zero
    out += String(n % 10);
  }
  return out;
}

/** "917 five five five 0199" -> "917 5 5 5 0199" (spelled digits, English and Spanish). */
export const spellToDigits = (text: string): string => text.replace(SPELLED_RE, (w) => SPELLED[w.toLowerCase()] ?? w);

/** The text a scanner should read: NFKC (full-width letters and digits, ligatures), then every digit as ASCII. */
export const scanText = (body: string): string => foldDigits(body.normalize('NFKC'));

function squashedPayment(text: string): boolean {
  const base = text.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  const variants = [
    base, base.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's').replace(/@/g, 'a'),
    base.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's').replace(/@/g, 'a'),
  ];
  return variants.some((v) => { const sq = v.replace(/[^\p{L}\p{N}]/gu, ''); return PAYMENT_SQUASHED.some((t) => sq.includes(t)); });
}

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
  const refuse = (p: ReplyBodyProblem): ReplyBody => ({ ok: false, problem: p, flagged: false });
  // Look-alike letters (Cyrillic i in "gift", Greek o ...) cannot be read by the word scanners: only Latin letters are relayed.
  if (NON_LATIN_LETTER_RE.test(body)) return refuse('symbols');
  // Everything below reads the NFKC + ASCII-digit form, so full-width and Arabic-Indic digits and ligatures cannot hide a number or a brand.
  const text = scanText(body);
  if (text !== body) {
    const folded = ownerTextProblem(text, 10_000);
    if (folded) return { ok: false, problem: folded, flagged: folded === 'injection' || folded === 'tool_name' || folded === 'control' };
  }
  if (text.includes('@') || text.includes('#')) return refuse('url');
  if (LINKWORD_RES.some((re) => re.test(text))) return refuse('url');
  const spelled = spellToDigits(text);
  if (VANITY_RES.some((re) => re.test(text))) return refuse('digits');
  if (DIGIT_RES.some((re) => re.test(text) || re.test(spelled))) return refuse('digits');
  if (PAYMENT_RE.test(text) || squashedPayment(text)) return refuse('payment');
  if (SYMBOL_RE.test(body)) return refuse('symbols');
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
  const from = o.callAt ? say(lang, ` Call at ${o.callAt}. Not you? Reply NO ${o.code}.`, ` Llamada a las ${o.callAt}. No fue usted? Responda NO ${o.code}.`) : '';
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

export type LeadKind = 'emergency' | 'handoff' | 'missed' | 'voicemail' | 'call' | 'booking' | 'text';

const KIND_WORD: Record<LeadKind, [string, string]> = {
  emergency: ['an emergency call', 'una llamada de emergencia'],
  handoff: ['a call handed to you', 'una llamada transferida a usted'],
  missed: ['a missed call', 'una llamada perdida'],
  voicemail: ['a voicemail', 'un mensaje de voz'],
  call: ['a call', 'una llamada'],
  booking: ['a booking', 'una cita'],
  text: ['a text message', 'un mensaje de texto'],
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
