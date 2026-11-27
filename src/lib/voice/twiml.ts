/**
 * TwiML for the non-AI call modes (paused / forwarded). Pure string builders; every dynamic value is XML-escaped, and
 * nothing here records a call except the explicit voicemail <Record>, which is always preceded by the recording notice.
 */
import { configEnv } from '@/lib/config';
import type { Business } from '@/lib/types';

export const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const wrap = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

export const TWIML_HEADERS = { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' } as const;
export const twimlResponse = (xml: string, status = 200): Response => new Response(xml, { status, headers: TWIML_HEADERS });

/**
 * Seconds a forwarded call rings before it is treated as unanswered. Default 20: shorter than the ~25 s after which most carriers'
 * voicemail picks up, so the owner's carrier voicemail does not "answer" and get bridged (and metered) for a silent caller.
 * FORWARD_RING_SECONDS overrides it (10-40).
 */
export const FORWARD_RING_SECONDS = 20;
export function forwardRingSeconds(env: Record<string, string | undefined> = configEnv()): number {
  const raw = (env.FORWARD_RING_SECONDS ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 10 && n <= 40 ? n : FORWARD_RING_SECONDS;
}
/** Longest voicemail (seconds). */
export const VOICEMAIL_MAX_SECONDS = 90;

/**
 * What a caller hears when the AI is paused, before the beep. It says plainly that the AI is off, that the message
 * will be RECORDED (this is the recording notice for the voicemail), and how to decline (hang up). English then Spanish.
 */
export function pausedVoicemailPrompt(business: Pick<Business, 'name'>): { en: string; es: string } {
  return {
    en: `Thanks for calling ${business.name}. Our assistant is not answering calls right now. After the tone, please leave your name, number and a short message, and we will call you back. Your message will be recorded. Hang up now if you do not want to leave one.`,
    es: `Gracias por llamar a ${business.name}. Nuestra asistente no está atendiendo llamadas en este momento. Después del tono, deje su nombre, número y un mensaje breve, y le devolveremos la llamada. Su mensaje será grabado. Cuelgue ahora si no desea dejar uno.`,
  };
}

/** Paused: say the notice, then record a voicemail and post it to `voicemailAction`. */
export function pausedTwiml(business: Pick<Business, 'name'>, voicemailAction: string): string {
  const p = pausedVoicemailPrompt(business);
  return wrap(
    `<Say language="en-US">${xmlEscape(p.en)}</Say>`
    + `<Say language="es-MX">${xmlEscape(p.es)}</Say>`
    + `<Record action="${xmlEscape(voicemailAction)}" method="POST" maxLength="${VOICEMAIL_MAX_SECONDS}" playBeep="true" timeout="6" trim="trim-silence"/>`
    + '<Say language="en-US">We did not receive a message. Goodbye.</Say><Hangup/>',
  );
}

/**
 * Forwarded: ring `to`. Never `record` (a forwarded call is not recorded by us), caller id stays the business line when it
 * is known so the owner sees it is a business call. `to` must be an E.164 the caller of this function already trusts.
 */
export function forwardTwiml(to: string, opts: { callerId?: string | null; action?: string; timeLimit?: number; statusCallback?: string; ringSeconds?: number; screenUrl?: string } = {}): string {
  if (!/^\+[1-9]\d{7,14}$/.test(to)) throw new RangeError('forward target must be E.164');
  const callerId = opts.callerId && /^\+[1-9]\d{7,14}$/.test(opts.callerId) ? ` callerId="${xmlEscape(opts.callerId)}"` : '';
  const action = opts.action ? ` action="${xmlEscape(opts.action)}" method="POST"` : '';
  // `timeLimit` caps the BRIDGED call (seconds) so a forwarded call can never outlive the minutes the plan has left.
  const limit = opts.timeLimit !== undefined && Number.isFinite(opts.timeLimit) && opts.timeLimit >= 1 ? ` timeLimit="${Math.floor(opts.timeLimit)}"` : '';
  // The per-leg "completed" callback reports the bridged duration even when the caller hangs up first (metered once per call).
  const status = opts.statusCallback ? ` statusCallback="${xmlEscape(opts.statusCallback)}" statusCallbackEvent="completed" statusCallbackMethod="POST"` : '';
  return wrap(`<Dial timeout="${opts.ringSeconds !== undefined && Number.isInteger(opts.ringSeconds) && opts.ringSeconds >= 5 && opts.ringSeconds <= 60 ? opts.ringSeconds : FORWARD_RING_SECONDS}" answerOnBridge="true"${limit}${callerId}${action}><Number${opts.screenUrl ? ` url="${xmlEscape(opts.screenUrl)}" method="POST"` : ''}${status}>${xmlEscape(to)}</Number></Dial>`);
}

/** How a caller number is read aloud to the owner: digit by digit ("+1 5 5 5 ..."), or "an unknown number" when withheld. */
export function spokenNumber(from: string | null | undefined): string {
  const digits = (from ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 7 ? digits.split('').join(' ') : 'an unknown number';
}

/**
 * Call screening whisper: the TwiML Twilio runs on the OWNER's leg after they answer and BEFORE the legs are bridged (`<Number url>`; only
 * Play / Say / Gather / Hangup are allowed there). "Press 1 to accept"; anything else, or no input, hangs up this leg only, so a carrier
 * voicemail (which cannot press 1) never gets bridged to the caller. The caller hears ringing the whole time (answerOnBridge).
 */
export function screenPromptTwiml(business: Pick<Business, 'name'>, from: string | null | undefined, action: string): string {
  const say = `${business.name} call from ${spokenNumber(from)}. Press 1 to accept.`;
  return wrap(
    `<Gather input="dtmf" numDigits="1" timeout="6" action="${xmlEscape(action)}" method="POST"><Say language="en-US">${xmlEscape(say)}</Say></Gather>`
    + '<Hangup/>',
  );
}
/** Accepted: an empty response ends the whisper and Twilio bridges the two legs. */
export const screenAcceptTwiml = (): string => wrap('');
/** Declined / no input: hang up the owner's leg; the <Dial> ends unanswered and the caller falls through to voicemail. */
export const screenDeclineTwiml = (): string => wrap('<Hangup/>');

/** Said when the voicemail budget of the hour is spent or the line cannot take a message: honest, short, then hang up (no <Record>). */
export const unavailableTwiml = (): string => wrap(
  '<Say language="en-US">We cannot take your call right now. Please try again later. Goodbye.</Say>'
  + '<Say language="es-MX">No podemos atender su llamada en este momento. Intente de nuevo m\u00e1s tarde. Adi\u00f3s.</Say><Hangup/>',
);

export const thanksTwiml = (): string => wrap('<Say language="en-US">Thank you. Goodbye.</Say><Hangup/>');
export const emptyHangupTwiml = (): string => wrap('<Hangup/>');

/**
 * A signed Twilio call must NEVER be answered with JSON (the caller would hear "an application error"). When a branch has no AI to connect
 * on a webhook line, it says so plainly and hangs up: `owner` for the owner line, `ai` when the AI cannot be reached right now.
 */
export const lineNoticeTwiml = (kind: 'owner' | 'ai'): string => wrap(kind === 'owner'
  ? '<Say language="en-US">The owner line is not available on this phone line. Please use your dashboard to update your assistant. Goodbye.</Say>'
    + '<Say language="es-MX">La l\u00ednea del due\u00f1o no est\u00e1 disponible en este n\u00famero. Use su panel para actualizar a su asistente. Adi\u00f3s.</Say><Hangup/>'
  : '<Say language="en-US">Our assistant cannot take your call right now. Please try again later. Goodbye.</Say>'
    + '<Say language="es-MX">Nuestra asistente no puede atender su llamada en este momento. Intente de nuevo m\u00e1s tarde. Adi\u00f3s.</Say><Hangup/>');
