/**
 * Per-business call handling mode: the PURE routing decision shared by both voice entry paths
 * (/api/voice/incoming and the ElevenLabs conversation-initiation webhook) and by the dashboard.
 *
 *   mode 'ai'      (default) the AI receptionist answers.
 *   mode 'paused'  the AI does not answer: the caller hears a short polite message and can leave a message
 *                  (voicemail on the Twilio path, callback capture by the agent on the native path).
 *   mode 'forward' calls ring `forward_number`, but ONLY a number that is verified (SMS code, or the verified owner
 *                  phone). With `forward_during_hours` the forward applies inside business hours only; outside them
 *                  the AI answers ("business hours -> you, after hours -> AI").
 *
 * A forward mode whose number is missing or no longer verified never dials anything: the AI answers instead (the
 * safe, honest fallback) and the reason is returned so it can be logged and shown.
 */
import { openWindow } from '@/lib/availability';
import { localDateKey, tzOf } from '@/lib/time';
import type { Business, CallMode, Hours } from '@/lib/types';

export const CALL_MODES: readonly CallMode[] = ['ai', 'paused', 'forward'];
export const isCallMode = (v: unknown): v is CallMode => typeof v === 'string' && (CALL_MODES as readonly string[]).includes(v);

type ModeFields = Pick<Business, 'call_mode' | 'forward_number_e164' | 'forward_number_verified_at' | 'forward_during_hours' | 'owner_phone_e164' | 'owner_phone_verified_at' | 'hours' | 'timezone'>;

/**
 * The E.164 this business may forward to, or null. Trusted means: the number was verified by SMS code, or it is the
 * owner phone that was itself verified. Never an unverified number.
 */
export function trustedForwardNumber(b: Pick<ModeFields, 'forward_number_e164' | 'forward_number_verified_at' | 'owner_phone_e164' | 'owner_phone_verified_at'>): string | null {
  const n = b.forward_number_e164 ?? null;
  if (!n) return null;
  if (b.forward_number_verified_at) return n;
  if (b.owner_phone_verified_at && b.owner_phone_e164 === n) return n;
  return null;
}

/** Inside today's opening window in the business zone? (Closed days are closed.) */
export function isOpenNow(hours: Hours | undefined | null, tz: string, now: Date = new Date()): boolean {
  const w = openWindow(hours, localDateKey(now, tz), tz);
  return Boolean(w) && now.getTime() >= w!.start && now.getTime() < w!.end;
}

export type CallRoute =
  | { action: 'ai'; why: 'mode_ai' | 'forward_outside_hours' | 'forward_number_unverified' }
  | { action: 'paused' }
  | { action: 'forward'; to: string };

export function resolveCallRoute(b: ModeFields, now: Date = new Date()): CallRoute {
  const mode = b.call_mode ?? 'ai';
  if (mode === 'paused') return { action: 'paused' };
  if (mode !== 'forward') return { action: 'ai', why: 'mode_ai' };
  const to = trustedForwardNumber(b);
  if (!to) return { action: 'ai', why: 'forward_number_unverified' };
  if (b.forward_during_hours && !isOpenNow(b.hours, tzOf(b.timezone), now)) return { action: 'ai', why: 'forward_outside_hours' };
  return { action: 'forward', to };
}

/** Short status line for the dashboard toggle, e.g. "AI is answering calls". */
export function callModeLabel(b: ModeFields, now: Date = new Date()): { text: string; tone: 'ok' | 'warn' | 'info' } {
  const r = resolveCallRoute(b, now);
  if (r.action === 'paused') return { text: 'Paused: callers are asked to leave a message', tone: 'warn' };
  if (r.action === 'forward') return { text: `Forwarding to ${maskNumber(r.to)}`, tone: 'info' };
  if ((b.call_mode ?? 'ai') === 'forward') {
    return r.why === 'forward_outside_hours'
      ? { text: 'AI is answering calls (after hours; forwarding resumes when you open)', tone: 'ok' }
      : { text: 'AI is answering calls (forward number is not verified)', tone: 'warn' };
  }
  return { text: 'AI is answering calls', tone: 'ok' };
}

/** "+1 ••• ••• 4567": enough to recognise, never the whole number in a header. */
export function maskNumber(e164: string): string {
  const last4 = e164.slice(-4);
  return e164.startsWith('+1') ? `+1 ••• ••• ${last4}` : `${e164.slice(0, 3)} ••• ${last4}`;
}

/** What the API/dashboard shows about the mode. The full forward number is only included for owners (`full`). */
export interface CallModeView {
  call_mode: CallMode;
  forward_during_hours: boolean;
  forward_number_masked: string | null;
  forward_number: string | null;
  forward_verified: boolean;
  /** True when the forward number is the verified owner phone (no separate SMS check was needed). */
  forward_is_owner_phone: boolean;
  /** What would happen to a call arriving right now. */
  route_now: 'ai' | 'paused' | 'forward';
  label: string;
  tone: 'ok' | 'warn' | 'info';
}

export function callModeView(b: ModeFields & { forward_number?: string | null }, opts: { full?: boolean } = {}, now: Date = new Date()): CallModeView {
  const trusted = trustedForwardNumber(b);
  const label = callModeLabel(b, now);
  return {
    call_mode: b.call_mode ?? 'ai',
    forward_during_hours: b.forward_during_hours ?? false,
    forward_number_masked: b.forward_number_e164 ? maskNumber(b.forward_number_e164) : null,
    forward_number: opts.full ? (b.forward_number_e164 ?? b.forward_number ?? null) : null,
    forward_verified: trusted !== null,
    forward_is_owner_phone: trusted !== null && !b.forward_number_verified_at,
    route_now: resolveCallRoute(b, now).action,
    label: label.text,
    tone: label.tone,
  };
}
