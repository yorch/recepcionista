/**
 * Inbound SMS keyword handling (CTIA / Twilio standard keywords). Pure.
 * Matching follows carrier practice: the WHOLE message, trimmed, case-insensitive, optional
 * trailing punctuation — "please stop" or "stop texting me" is NOT a keyword (it is left to a human).
 */
export type SmsKeyword = 'stop' | 'start' | 'help' | null;

const STOP = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START = new Set(['START', 'YES', 'UNSTOP']);

export function parseKeyword(body: string | null | undefined): SmsKeyword {
  const w = (body ?? '').trim().replace(/[.!?,\s]+$/g, '').toUpperCase();
  if (STOP.has(w)) return 'stop';
  if (START.has(w)) return 'start';
  if (w === 'HELP' || w === 'INFO') return 'help';
  return null;
}

export function stopReply(businessName: string): string {
  return `${businessName}: You are unsubscribed and will receive no more texts from us. Reply START to resubscribe.`;
}

export function startReply(businessName: string): string {
  return `${businessName}: You are resubscribed to texts about your appointments. Reply STOP to opt out.`;
}

export function helpReply(businessName: string, phone?: string | null): string {
  const call = phone ? ` Call ${phone} for help.` : '';
  return `${businessName}: appointment texts from our AI receptionist.${call} Reply STOP to opt out. Msg&data rates may apply.`;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}

export function twiml(message?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${escapeXml(message)}</Message>` : ''}</Response>`;
}
