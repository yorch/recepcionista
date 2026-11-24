/**
 * TwiML for the non-AI call modes (paused / forwarded). Pure string builders; every dynamic value is XML-escaped, and
 * nothing here records a call except the explicit voicemail <Record>, which is always preceded by the recording notice.
 */
import type { Business } from '@/lib/types';

export const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const wrap = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

export const TWIML_HEADERS = { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' } as const;
export const twimlResponse = (xml: string, status = 200): Response => new Response(xml, { status, headers: TWIML_HEADERS });

/** Seconds a forwarded call rings before it is treated as unanswered. */
export const FORWARD_RING_SECONDS = 25;
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
export function forwardTwiml(to: string, opts: { callerId?: string | null; action?: string; timeLimit?: number; statusCallback?: string } = {}): string {
  if (!/^\+[1-9]\d{7,14}$/.test(to)) throw new RangeError('forward target must be E.164');
  const callerId = opts.callerId && /^\+[1-9]\d{7,14}$/.test(opts.callerId) ? ` callerId="${xmlEscape(opts.callerId)}"` : '';
  const action = opts.action ? ` action="${xmlEscape(opts.action)}" method="POST"` : '';
  // `timeLimit` caps the BRIDGED call (seconds) so a forwarded call can never outlive the minutes the plan has left.
  const limit = opts.timeLimit !== undefined && Number.isFinite(opts.timeLimit) && opts.timeLimit >= 1 ? ` timeLimit="${Math.floor(opts.timeLimit)}"` : '';
  // The per-leg "completed" callback reports the bridged duration even when the caller hangs up first (metered once per call).
  const status = opts.statusCallback ? ` statusCallback="${xmlEscape(opts.statusCallback)}" statusCallbackEvent="completed" statusCallbackMethod="POST"` : '';
  return wrap(`<Dial timeout="${FORWARD_RING_SECONDS}" answerOnBridge="true"${limit}${callerId}${action}><Number${status}>${xmlEscape(to)}</Number></Dial>`);
}

/** Said when the voicemail budget of the hour is spent or the line cannot take a message: honest, short, then hang up (no <Record>). */
export const unavailableTwiml = (): string => wrap(
  '<Say language="en-US">We cannot take your call right now. Please try again later. Goodbye.</Say>'
  + '<Say language="es-MX">No podemos atender su llamada en este momento. Intente de nuevo m\u00e1s tarde. Adi\u00f3s.</Say><Hangup/>',
);

export const thanksTwiml = (): string => wrap('<Say language="en-US">Thank you. Goodbye.</Say><Hangup/>');
export const emptyHangupTwiml = (): string => wrap('<Hangup/>');
