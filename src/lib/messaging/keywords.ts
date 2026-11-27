/**
 * Inbound SMS keyword handling (CTIA / Twilio standard keywords plus the FCC "reasonable means" revocation
 * words). Pure.
 *
 * The message is normalised first (Unicode NFKC, so full-width "ＳＴＯＰ" works; case and accents folded; quotes,
 * punctuation and emoji dropped; whitespace collapsed). Then:
 *  - the whole message is a stop keyword ("STOP", "Opt out", "\"stop\"", "STOP 🛑"), or
 *  - it is a stop keyword followed by at most three words that all belong to a short list of ordinary
 *    revocation phrasing ("stop texting me", "please stop messaging me now", "unsubscribe me"), but NOT by arbitrary
 *    words: "stop by tomorrow at 5" and "nonstop" are ordinary messages, left to a human.
 * A bare "YES" is not a re-subscribe (it answers whatever question was last asked): only START / UNSTOP are.
 */
export type SmsKeyword = 'stop' | 'start' | 'help' | null;

const STOP = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT',
  'PARAR', 'ALTO', 'BAJA', 'DETENER', 'ARRET',
]);
/** Two-word forms of the above ("opt out", "stop all"). */
const STOP_PAIRS = new Set(['OPT OUT', 'STOP ALL']);
const START = new Set(['START', 'UNSTOP']);
const HELP = new Set(['HELP', 'INFO', 'AYUDA']);
const FILLER_LEAD = new Set(['PLEASE', 'PLS', 'PLZ', 'KINDLY', 'JUST', 'POR', 'FAVOR', 'PORFAVOR']);
/** Words allowed after a stop keyword in a revocation sentence. Anything else (by, tomorrow, at, 5 ...) is not one. */
const FILLER_TRAIL = new Set([
  'TEXTING', 'TEXTS', 'TEXT', 'MESSAGING', 'MESSAGES', 'MESSAGE', 'SENDING', 'CALLING', 'CONTACTING', 'EMAILING',
  'ME', 'US', 'MY', 'THIS', 'THESE', 'THEM', 'ALL', 'NUMBER', 'FROM', 'TO', 'NOW', 'PLEASE', 'PLS', 'PLZ',
  'THANKS', 'THANK', 'YOU', 'IMMEDIATELY', 'ANYMORE', 'MORE', 'NO', 'AGAIN', 'FOREVER',
  'MENSAJES', 'TEXTOS', 'YA', 'ENVIAR', 'ESCRIBIR', 'ESCRIBIRME', 'MANDAR', 'GRACIAS', 'FAVOR', 'POR',
]);

/** NFKC, fold case and accents, drop punctuation/emoji, collapse whitespace. Exported for tests. */
export function normalizeInbound(body: string | null | undefined): string {
  return (body ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-message affirmative answers that grant follow-up consent (the customer's own, explicit text to the business number). */
const POSITIVE = new Set(['YES', 'Y', 'SI', 'START']);

/** True when the ENTIRE message is YES / Y / SI / START (case, accents, punctuation folded). */
export function isPositiveKeyword(body: string | null | undefined): boolean {
  return POSITIVE.has(normalizeInbound(body));
}

export function parseKeyword(body: string | null | undefined): SmsKeyword {
  const text = normalizeInbound(body);
  if (!text) return null;
  if (START.has(text)) return 'start';
  if (HELP.has(text)) return 'help';

  const tokens = text.split(' ');
  while (tokens.length > 1 && FILLER_LEAD.has(tokens[0])) tokens.shift();
  let rest: string[] | null = null;
  if (tokens.length >= 2 && STOP_PAIRS.has(`${tokens[0]} ${tokens[1]}`)) rest = tokens.slice(2);
  else if (STOP.has(tokens[0])) rest = tokens.slice(1);
  if (rest && rest.length <= 3 && rest.every((w) => FILLER_TRAIL.has(w))) return 'stop';
  return null;
}

/** An ordinary message that nevertheless contains a stop word: not an automatic opt-out, but worth a human look. */
export function mentionsStopWord(body: string | null | undefined): boolean {
  const text = ` ${normalizeInbound(body)} `;
  return [...STOP, ...STOP_PAIRS].some((w) => text.includes(` ${w} `));
}

/** Plain-language ways to ask for no more texts that are not a keyword (the FCC accepts any reasonable means). Matched on the normalised text. */
const REVOCATION_PHRASES: RegExp[] = [
  /\b(?:DON T|DO NOT|DONT|NEVER|STOP) (?:TEXT|TEXTING|MESSAGE|MESSAGING|CALL|CALLING|CONTACT|CONTACTING|SEND|SENDING|EMAIL)/,
  /\b(?:REMOVE|DELETE|TAKE) (?:ME|MY NUMBER|THIS NUMBER|US)\b/,
  /\bNO MORE (?:TEXTS?|MESSAGES?|SMS)\b/,
  /\bLEAVE ME ALONE\b/,
  /\bWRONG (?:NUMBER|PERSON)\b/,
  /\bNOT (?:THE PERSON|MY NUMBER|SOMEONE YOU)\b/,
  /\bNO ME (?:ESCRIBA|ESCRIBAN|MANDE|MANDEN|ENVIE|ENVIEN|TEXTEE|LLAME|LLAMEN|CONTACTE)\b/,
  /\b(?:QUITE|ELIMINE|BORRE|SAQUE) (?:ME|MI NUMERO|ESTE NUMERO)\b/,
  /\b(?:NUMERO EQUIVOCADO|NO MAS (?:MENSAJES|TEXTOS))\b/,
];

/**
 * Might this text be a request to stop receiving texts? True for a stop word anywhere (`mentionsStopWord`) and for the plain-language
 * phrasings above. Not an automatic opt-out (it could be "stop by at 5"): the inbox sends NO auto-reply to it and flags it for the owner.
 */
export function looksLikeRevocation(body: string | null | undefined): boolean {
  if (mentionsStopWord(body)) return true;
  const text = normalizeInbound(body);
  return REVOCATION_PHRASES.some((re) => re.test(text));
}

export function stopReply(businessName: string): string {
  return `${businessName}: You are unsubscribed and will receive no more texts from us. Reply START to resubscribe.`;
}

export function startReply(businessName: string): string {
  return `${businessName}: You are resubscribed to texts about your appointments. Reply STOP to opt out.`;
}

export function consentReply(businessName: string): string {
  return `${businessName}: Thanks! We may text you after your visit to ask how it went. Reply STOP to opt out.`;
}

export function helpReply(businessName: string, phone?: string | null, termsUrl?: string | null): string {
  const call = phone ? ` Call ${phone} for help.` : '';
  const terms = termsUrl ? ` Terms: ${termsUrl}` : '';
  return `${businessName}: appointment texts from our AI receptionist.${call} Reply STOP to opt out. Msg&data rates may apply.${terms}`;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}

export function twiml(message?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${escapeXml(message)}</Message>` : ''}</Response>`;
}
