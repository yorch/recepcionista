/**
 * Confirmation codes and SMS commands for owner knowledge changes. Pure (the key is passed in).
 *
 * A code is a short stateless HMAC of (business id, change id), keyed from APP_SECRET_KEY, so it is bound to ONE business and ONE
 * change and nothing about it is stored. What makes it single-use and time-limited is the change's own status/time columns
 * (proposed -> applied -> reverted), checked by sms.ts. UNDO of an older change (asked for by voice) uses a code that also covers a
 * 30-minute time bucket, so it expires by itself.
 */
import crypto from 'node:crypto';
import { OWNER_CODE_TTL_MS } from './config';
import { normalizeInbound } from '@/lib/messaging/keywords';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
export const OWNER_CODE_LENGTH = 6;

/** Domain-separated sub-key: the raw APP_SECRET_KEY never signs anything directly. */
const subKey = (key: Buffer): Buffer => crypto.createHmac('sha256', key).update('owner-callin-code-v1').digest();

export function ownerCode(key: Buffer, businessId: string, changeId: string, scope: string = 'c'): string {
  const mac = crypto.createHmac('sha256', subKey(key)).update(`${businessId}|${changeId}|${scope}`).digest();
  let out = '';
  for (let i = 0; i < OWNER_CODE_LENGTH; i++) out += ALPHABET[mac[i] & 31];
  return out;
}

export const undoBucket = (now: Date): number => Math.floor(now.getTime() / OWNER_CODE_TTL_MS);
/** UNDO code for a change that is no longer fresh: valid in the 30-minute bucket it was issued in and the next one (30-60 minutes). */
export const undoScope = (bucket: number): string => `u${bucket}`;

/** Constant-time equality of two codes (any case). */
export function codesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a.toUpperCase()), y = Buffer.from(b.toUpperCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export type OwnerSmsAction = 'yes' | 'no' | 'undo';
export interface OwnerSmsCommand { action: OwnerSmsAction; code: string }

const YES = new Set(['YES', 'Y', 'SI', 'OK', 'CONFIRM']);
const NO = new Set(['NO', 'N']);
const UNDO = new Set(['UNDO', 'REVERT', 'DESHACER']);

/** "YES K7M2QX" -> command. Exactly a verb and a well-formed code, nothing else (STOP-class words never parse: they are handled before this). */
export function parseOwnerSms(body: string | null | undefined): OwnerSmsCommand | null {
  const tokens = normalizeInbound(body).split(' ');
  if (tokens.length !== 2) return null;
  const [verb, code] = tokens;
  if (code.length !== OWNER_CODE_LENGTH || ![...code].every((c) => ALPHABET.includes(c))) return null;
  if (YES.has(verb)) return { action: 'yes', code };
  if (NO.has(verb)) return { action: 'no', code };
  if (UNDO.has(verb)) return { action: 'undo', code };
  return null;
}

export const withinTtl = (since: Date | string | null, now: Date = new Date()): boolean => {
  if (!since) return false;
  const t = new Date(since).getTime();
  return Number.isFinite(t) && now.getTime() - t <= OWNER_CODE_TTL_MS && now.getTime() >= t - 60_000;
};

type Lang = 'en' | 'es';

/** The confirmation text (<= 320 chars once the summary is cut to fit). Mentions all three commands, as the owner needs. */
export function confirmationSms(summary: string, code: string, lang: Lang = 'en', callAt?: string): string {
  const s = summary.length > 150 ? `${summary.slice(0, 147)}...` : summary;
  // Caller id can be spoofed: say where the request came from so the real owner can tell it was not them (and cancel it).
  const from = callAt ? (lang === 'es' ? ` Pedido en una llamada a las ${callAt}. No fue usted? Responda NO ${code}.` : ` Requested on a call at ${callAt}. Not you? Reply NO ${code}.`) : '';
  return lang === 'es'
    ? `Responda SI ${code} para aplicar: ${s}. Responda NO ${code} para cancelar. DESHACER ${code} para revertir. Vence en 30 min.${from}`
    : `Reply YES ${code} to apply: ${s}. Reply NO ${code} to cancel. UNDO ${code} to revert. Expires in 30 min.${from}`;
}

export function undoSms(summary: string, code: string, lang: Lang = 'en', callAt?: string): string {
  const s = summary.length > 150 ? `${summary.slice(0, 147)}...` : summary;
  const from = callAt ? (lang === 'es' ? ` Pedido en una llamada a las ${callAt}. No fue usted? Ignore este mensaje.` : ` Requested on a call at ${callAt}. Not you? Ignore this text.`) : '';
  return lang === 'es' ? `Responda DESHACER ${code} para revertir: ${s}. Vence en 30 min.${from}` : `Reply UNDO ${code} to revert: ${s}. Expires in 30 min.${from}`;
}

/** "3:12 PM" in the business time zone, for the "requested on a call at" line (ASCII only: the text stays GSM-7). */
export function callClock(at: Date | string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(new Date(at)).replace(/[\u202f\u00a0]/g, ' ');
  } catch { return ''; }
}
