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
import { defaultPhoneCountry, phoneCountry } from '@/lib/phone';
import { localDateKey, tzOf } from '@/lib/time';
import { validateForwardNumber } from '@/lib/voice/forward-number';
import { FORWARD_UNAVAILABLE, forwardingSupported, lineKind, type LineKind } from '@/lib/voice/line';
import type { Business, CallMode, Hours } from '@/lib/types';

export const CALL_MODES: readonly CallMode[] = ['ai', 'paused', 'forward'];
export const isCallMode = (v: unknown): v is CallMode => typeof v === 'string' && (CALL_MODES as readonly string[]).includes(v);

type ModeFields = Pick<Business, 'call_mode' | 'forward_number_e164' | 'forward_number_verified_at' | 'forward_during_hours' | 'owner_phone_e164' | 'owner_phone_verified_at' | 'hours' | 'timezone' | 'closed_dates'>
  & { phone_e164?: string | null };

type TrustFields = Pick<ModeFields, 'forward_number_e164' | 'forward_number_verified_at' | 'owner_phone_e164' | 'owner_phone_verified_at' | 'phone_e164'>;

/** Why a stored forward number cannot be dialled right now. */
export type ForwardTarget =
  | { ok: true; to: string }
  | { ok: false; why: 'none' | 'unverified' | 'rejected'; error?: string };

/**
 * The forward target, or why there is none. A number is dialled only when it is BOTH
 *  - proven: verified by SMS code, or the owner phone that was itself verified; and
 *  - allowed: it passes validateForwardNumber (premium / Caribbean / territory / 976 / toll-free / short / country allow-list /
 *    not the business's own line) AT THIS MOMENT, whichever path stored it (a verified owner phone is NOT exempt, and a number that
 *    was legal when saved stops being dialled after the deny list or country list changes).
 */
export function forwardTarget(b: TrustFields): ForwardTarget {
  const n = b.forward_number_e164 ?? null;
  if (!n) return { ok: false, why: 'none' };
  const proven = Boolean(b.forward_number_verified_at) || Boolean(b.owner_phone_verified_at && b.owner_phone_e164 === n);
  if (!proven) return { ok: false, why: 'unverified' };
  const country = phoneCountry(b.phone_e164) ?? defaultPhoneCountry();
  const check = validateForwardNumber(n, country, { ownLines: [b.phone_e164] });
  if (!check.ok || check.e164 !== n) return { ok: false, why: 'rejected', error: check.ok ? 'not a normalised number' : check.error };
  return { ok: true, to: n };
}

/**
 * The E.164 this business may forward to, or null. Trusted means: verified (SMS code, or the verified owner phone) AND still
 * passing the forward-number rules. Never an unverified or disallowed number.
 */
export function trustedForwardNumber(b: TrustFields): string | null {
  const t = forwardTarget(b);
  return t.ok ? t.to : null;
}

/** Inside today's opening window in the business zone? (Closed days are closed.) */
export function isOpenNow(hours: Hours | undefined | null, tz: string, now: Date = new Date(), closedDates?: readonly string[] | null): boolean {
  const w = openWindow(hours, localDateKey(now, tz), tz, closedDates);
  return Boolean(w) && now.getTime() >= w!.start && now.getTime() < w!.end;
}

export type CallRoute =
  | { action: 'ai'; why: 'mode_ai' | 'forward_outside_hours' | 'forward_number_unverified' | 'forward_number_rejected' }
  | { action: 'paused'; why?: 'forward_unavailable_on_line' }
  | { action: 'forward'; to: string };

/**
 * What happens to a call arriving now. THE one decision shared by the phone paths, the voice tools and the dashboard, so they
 * cannot disagree (the tools refuse booking / texting exactly when this is not 'ai'). `line` is the kind of line the call is on
 * (default: this deployment's); on a 'native' line `forward` can never happen, so a due forward is the paused script.
 */
export function resolveCallRoute(b: ModeFields, now: Date = new Date(), line: LineKind = lineKind()): CallRoute {
  const mode = b.call_mode ?? 'ai';
  if (mode === 'paused') return { action: 'paused' };
  if (mode !== 'forward') return { action: 'ai', why: 'mode_ai' };
  const target = forwardTarget(b);
  if (!target.ok) return { action: 'ai', why: target.why === 'rejected' ? 'forward_number_rejected' : 'forward_number_unverified' };
  if (b.forward_during_hours && !isOpenNow(b.hours, tzOf(b.timezone), now, b.closed_dates)) return { action: 'ai', why: 'forward_outside_hours' };
  if (!forwardingSupported(line)) return { action: 'paused', why: 'forward_unavailable_on_line' };
  return { action: 'forward', to: target.to };
}

/** Short status line for the dashboard toggle, e.g. "AI is answering calls". */
export type CallModeLabelCode = 'forward_unavailable' | 'paused' | 'forwarding' | 'ai_after_hours' | 'ai_rejected' | 'ai_unverified' | 'ai';

/** Same decision as callModeLabel, as a code the dashboard localizes (`callmode.label.<code>`). */
export function callModeLabelCode(b: ModeFields, now: Date = new Date(), line: LineKind = lineKind()): CallModeLabelCode {
  const r = resolveCallRoute(b, now, line);
  if (r.action === 'paused') return r.why === 'forward_unavailable_on_line' ? 'forward_unavailable' : 'paused';
  if (r.action === 'forward') return 'forwarding';
  if ((b.call_mode ?? 'ai') === 'forward') {
    if (r.why === 'forward_outside_hours') return 'ai_after_hours';
    if (r.why === 'forward_number_rejected') return 'ai_rejected';
    return 'ai_unverified';
  }
  return 'ai';
}

/** Short English status line for the dashboard toggle, e.g. "AI is answering calls" (the UI localizes it from `callModeLabelCode`). */
export function callModeLabel(b: ModeFields, now: Date = new Date(), line: LineKind = lineKind()): { text: string; tone: 'ok' | 'warn' | 'info' } {
  const r = resolveCallRoute(b, now, line);
  if (r.action === 'paused') {
    return r.why === 'forward_unavailable_on_line'
      ? { text: FORWARD_UNAVAILABLE, tone: 'warn' }
      : { text: 'Paused: callers are asked to leave a message', tone: 'warn' };
  }
  if (r.action === 'forward') return { text: `Forwarding to ${maskNumber(r.to)}`, tone: 'info' };
  if ((b.call_mode ?? 'ai') === 'forward') {
    if (r.why === 'forward_outside_hours') return { text: 'AI is answering calls (after hours; forwarding resumes when you open)', tone: 'ok' };
    if (r.why === 'forward_number_rejected') return { text: 'AI is answering calls (the forward number is not allowed)', tone: 'warn' };
    return { text: 'AI is answering calls (forward number is not verified)', tone: 'warn' };
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
  /** Can this deployment's phone line forward at all? False on the native ElevenLabs line (the Forward choice is disabled and explained). */
  forward_supported: boolean;
  /** Why a stored, verified number is NOT dialled (e.g. a premium or territory number, or a country no longer enabled), else null. */
  forward_blocked: string | null;
  label: string;
  /** The label as a code: the dashboard shows `callmode.label.<code>` in the viewer's language (`label` stays English for API clients). */
  label_code: CallModeLabelCode;
  tone: 'ok' | 'warn' | 'info';
}

export function callModeView(b: ModeFields & { forward_number?: string | null }, opts: { full?: boolean } = {}, now: Date = new Date(), line: LineKind = lineKind()): CallModeView {
  const target = forwardTarget(b);
  const trusted = target.ok ? target.to : null;
  const label = callModeLabel(b, now, line);
  return {
    call_mode: b.call_mode ?? 'ai',
    forward_during_hours: b.forward_during_hours ?? false,
    forward_number_masked: b.forward_number_e164 ? maskNumber(b.forward_number_e164) : null,
    forward_number: opts.full ? (b.forward_number_e164 ?? b.forward_number ?? null) : null,
    forward_verified: trusted !== null,
    forward_is_owner_phone: trusted !== null && !b.forward_number_verified_at,
    route_now: resolveCallRoute(b, now, line).action,
    forward_supported: forwardingSupported(line),
    forward_blocked: !target.ok && target.why === 'rejected' ? (target.error ?? 'this number cannot be used for forwarding') : null,
    label: label.text,
    label_code: callModeLabelCode(b, now, line),
    tone: label.tone,
  };
}
