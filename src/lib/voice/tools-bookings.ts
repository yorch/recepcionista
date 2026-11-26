/**
 * Voice tools that change an EXISTING booking: `reschedule_booking` and `cancel_booking`.
 *
 * Ownership is the whole point. A tool call is only as trustworthy as the number it comes from, so these tools act ONLY on a booking whose
 * phone (E.164) equals the VERIFIED caller number of this very call: the platform caller id (a system dynamic variable the model cannot
 * write; the route is secret-authenticated and binds the tenant from the agent id) and/or the call row's caller_phone. Anything the model
 * relays (a name, a phone number, a booking id) is NEVER trusted: a booking id is only a hint that must still pass the same check, and the
 * booking must belong to the resolved business. When the caller cannot be verified (withheld number, STIR/SHAKEN failed, row and platform
 * disagree) or no booking of theirs matches, the tool changes nothing and tells the agent to take a message (handoff_to_human): the answers
 * never reveal whether a booking of somebody else exists.
 *
 * Results are honest: "moved" is said only after the database says so; whether the confirmation text really went out is part of the message.
 * This file is imported by voice/tools.ts (dispatch) and voice/elevenlabs.ts (tool specs); it imports neither (no cycle).
 */
import {
  BookingRejectedError, findActiveCall, getBooking, getBusiness, prisma, updateCall, upsertCallForConversation, countryForBusiness,
} from '@/lib/db';
import { cancelBooking, rescheduleAndNotify, type NoticeResult } from '@/lib/booking-changes';
import { slotsForMove } from '@/lib/booking-slots';
import { schedulingOf } from '@/lib/business-config';
import { upcomingDateKeys } from '@/lib/availability';
import { addDaysToDateKey, localDateKey, parseScheduledAt, partsInTz, spokenTimeInTz, tzOf } from '@/lib/time';
import { toE164 } from '@/lib/phone';
import { normalizePhone } from '@/lib/providers/twilio';
import { E164 } from '@/lib/messaging/recipient';
import { formatCents } from '@/lib/money';
import { logger } from '@/lib/log';
import type { Booking, Business, Call } from '@/lib/types';

const log = logger('voice-tools-bookings');

export type BookingToolName = 'reschedule_booking' | 'cancel_booking';
export const BOOKING_TOOL_NAMES: readonly BookingToolName[] = ['reschedule_booking', 'cancel_booking'];

type Lang = 'en' | 'es';

interface ToolOut { ok: boolean; message: string; data?: unknown }

export interface BookingToolArgs {
  business_id?: string;
  call_id?: string;
  call_sid?: string;
  conversation_id?: string;
  /** Platform-supplied caller id (system__caller_id). */
  caller_phone?: string;
  language?: string;
  /** Optional hint; must still belong to the verified caller. */
  booking_id?: string;
  /** Local wall-clock start of the EXISTING booking, to pick one when the caller has several. */
  current_time?: string;
  /** reschedule: the new local wall-clock start. */
  new_scheduled_at?: string;
  /** cancel: true only after the caller said yes out loud. */
  confirmed?: boolean | string;
  reason?: string;
}

const langOf = (raw?: unknown): Lang => (typeof raw === 'string' && raw.toLowerCase().startsWith('es') ? 'es' : 'en');
const say = (lang: Lang, en: string, es: string): string => (lang === 'es' ? es : en);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function when(iso: string, lang: Lang, tz: string): string {
  const key = localDateKey(iso, tz);
  const today = localDateKey(new Date(), tz);
  const time = spokenTimeInTz(iso, tz);
  if (key === today) return lang === 'es' ? `hoy a las ${time}` : `today at ${time}`;
  if (key === addDaysToDateKey(today, 1)) return lang === 'es' ? `mañana a las ${time}` : `tomorrow at ${time}`;
  const p = partsInTz(iso, tz);
  const day = (lang === 'es' ? WEEKDAY_ES : WEEKDAY_EN)[p.weekday];
  const md = new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(new Date(iso));
  return lang === 'es' ? `el ${day} ${md} a las ${time}` : `${day}, ${md} at ${time}`;
}

const cleanPhone = (raw: unknown): string | null => {
  const v = str(raw);
  if (!v) return null;
  const n = normalizePhone(v);
  return E164.test(n) ? n : null;
};

/** The ONE reason text for "I will not touch it": the agent takes a message instead. Identical whatever the cause, so nothing is revealed. */
function notVerified(lang: Lang, reason: string): ToolOut {
  return {
    ok: false,
    message: say(lang,
      "I can't change that booking over the phone from this number, but I can take a message and have the owner call you back. Do you want me to do that?",
      'No puedo cambiar esa cita por teléfono desde este número, pero puedo tomar un mensaje para que el dueño le llame. ¿Quiere que lo haga?'),
    data: { reason, next: 'handoff_to_human' },
  };
}

export interface VerifiedCaller { call: Call | null; e164: string }

/**
 * The caller's E.164 for THIS call, or null (then nothing may be changed). Rules: the platform caller id and the call row's caller_phone,
 * when both exist, must be the same number; STIR/SHAKEN `caller_verified === false` refuses; a row of another business is ignored.
 */
export async function verifyCaller(business: Business, args: BookingToolArgs): Promise<VerifiedCaller | null> {
  const platform = cleanPhone(args.caller_phone);
  let call: Call | null = await findActiveCall(business.id, {
    callId: str(args.call_id) || undefined, callSid: str(args.call_sid) || undefined, conversationId: str(args.conversation_id) || undefined,
  });
  if (!call && (str(args.call_sid) || str(args.conversation_id))) {
    call = await upsertCallForConversation(business.id, { callSid: str(args.call_sid), conversationId: str(args.conversation_id), callerPhone: platform });
  }
  if (call && call.business_id !== business.id) call = null;
  const rowPhone = cleanPhone(call?.caller_phone);
  if (call && !rowPhone && platform && !call.caller_phone) call = (await updateCall(call.id, { caller_phone: platform })) ?? call;
  const country = countryForBusiness(business);
  const a = platform ? toE164(platform, country) : null;
  const b = rowPhone ? toE164(rowPhone, country) : null;
  if (a && b && a !== b) { log.warn('caller.mismatch', { business: business.id }); return null; }
  const e164 = a ?? b;
  if (!e164) return null;
  if (call?.caller_verified === false) { log.warn('caller.unverified_attestation', { business: business.id }); return null; }
  return { call, e164 };
}

const ACTIVE = ['pending', 'confirmed'];

/** Upcoming live bookings of this verified caller (their number, this business, not anonymised). */
export async function upcomingBookingsOf(business: Business, e164: string, now: Date = new Date()): Promise<Booking[]> {
  const rows = await prisma.booking.findMany({
    where: { businessId: business.id, phoneE164: e164, anonymizedAt: null, status: { in: ACTIVE }, scheduledAt: { gte: new Date(now.getTime() - 60 * 60_000) } },
    orderBy: { scheduledAt: 'asc' }, take: 10,
  });
  const out: Booking[] = [];
  for (const r of rows) { const b = await getBooking(r.id); if (b) out.push(b); }
  return out;
}

type Picked = { kind: 'one'; booking: Booking } | { kind: 'none' } | { kind: 'ask'; options: Booking[] };

async function pick(business: Business, caller: VerifiedCaller, args: BookingToolArgs): Promise<Picked> {
  const tz = tzOf(business);
  const mine = await upcomingBookingsOf(business, caller.e164);
  const hinted = str(args.booking_id);
  if (hinted) {
    // A hint is only ever a filter over the caller's OWN bookings: someone else's id is simply "not found".
    const hit = mine.find((b) => b.id === hinted);
    return hit ? { kind: 'one', booking: hit } : { kind: 'none' };
  }
  const t = str(args.current_time);
  if (t) {
    const parsed = parseScheduledAt(t, tz);
    if (parsed.ok) {
      const at = parsed.date.getTime();
      const hit = mine.filter((b) => Math.abs(new Date(b.scheduled_at).getTime() - at) < 30 * 60_000);
      if (hit.length === 1) return { kind: 'one', booking: hit[0] };
    }
  }
  if (mine.length === 0) return { kind: 'none' };
  if (mine.length === 1) return { kind: 'one', booking: mine[0] };
  return { kind: 'ask', options: mine.slice(0, 4) };
}

function askWhich(lang: Lang, tz: string, options: Booking[]): ToolOut {
  const list = options.map((b) => `${b.service} ${when(b.scheduled_at, lang, tz)}`).join(say(lang, '; or ', '; o '));
  return {
    ok: false,
    message: say(lang, `I see more than one upcoming booking under this number: ${list}. Which one do you mean?`, `Veo más de una cita próxima con este número: ${list}. ¿A cuál se refiere?`),
    data: { reason: 'which_booking', count: options.length },
  };
}

const nothingFound = (lang: Lang): ToolOut => ({
  ok: false,
  message: say(lang,
    "I don't see an upcoming booking under the number you're calling from. I can take a message and have the owner call you back. Do you want me to?",
    'No veo una cita próxima con el número desde el que llama. Puedo tomar un mensaje para que el dueño le llame. ¿Quiere que lo haga?'),
  data: { reason: 'no_booking_for_caller', next: 'handoff_to_human' },
});

const textClause = (lang: Lang, n: NoticeResult | null): string => {
  if (!n) return '';
  if (n.delivered) return say(lang, ' I sent you a text with the details.', ' Le envié un mensaje de texto con los detalles.');
  if (n.status === 'blocked_opt_out') return say(lang, " I can't text you because you opted out of our messages.", ' No le puedo enviar texto porque canceló nuestros mensajes.');
  if (n.status === 'skipped' || n.status === 'duplicate') return '';
  return say(lang, " I couldn't send the confirmation text, but the change is saved.", ' No pude enviar el mensaje de confirmación, pero el cambio quedó guardado.');
};

/** Most a voice call may move one booking in total (a runaway agent or a loop cannot churn the calendar). */
const MAX_VOICE_MOVES = 3;

export async function rescheduleBookingTool(args: BookingToolArgs): Promise<ToolOut> {
  const lang = langOf(args.language);
  try {
    const business = args.business_id ? await getBusiness(str(args.business_id)) : null;
    if (!business) return { ok: false, message: say(lang, 'Let me get the owner for that — one moment.', 'Permítame conseguir al dueño — un momento.') };
    const tz = tzOf(business);
    const caller = await verifyCaller(business, args);
    if (!caller) return notVerified(lang, 'caller_not_verified');
    const picked = await pick(business, caller, args);
    if (picked.kind === 'none') return nothingFound(lang);
    if (picked.kind === 'ask') return askWhich(lang, tz, picked.options);
    const booking = picked.booking;
    if ((booking.reschedule_count ?? 0) >= MAX_VOICE_MOVES) return notVerified(lang, 'too_many_changes');

    const target = str(args.new_scheduled_at);
    if (!target) {
      return { ok: false, message: say(lang, 'What day and time would you like to move it to?', '¿A qué día y hora le gustaría cambiarla?'), data: { reason: 'missing_time' } };
    }
    const parsed = parseScheduledAt(target, tz);
    if (!parsed.ok) {
      return { ok: false, message: say(lang, 'Which day and time did you have in mind?', '¿Qué día y hora tenía en mente?'), data: { reason: 'invalid_time' } };
    }
    try {
      const out = await rescheduleAndNotify({
        businessId: business.id, bookingId: booking.id, scheduled_at: parsed.date.toISOString(), initiator: 'customer',
        language: lang, actor: { kind: 'system', meta: { source: 'voice', call_id: caller.call?.id ?? null } },
      });
      const text = textClause(lang, out.notice);
      if (!out.result.changed) {
        return { ok: true, message: say(lang, `Your ${booking.service} is already at ${when(booking.scheduled_at, lang, tz)}. Nothing changed.`, `Su cita de ${booking.service} ya está para ${when(booking.scheduled_at, lang, tz)}. No cambió nada.`), data: { changed: false } };
      }
      return {
        ok: true,
        message: say(lang, `Done. Your ${booking.service} is now ${when(out.booking.scheduled_at, lang, tz)}.${text}`, `Listo. Su cita de ${booking.service} quedó para ${when(out.booking.scheduled_at, lang, tz)}.${text}`),
        data: { changed: true, booking_id: out.booking.id, scheduled_at: out.booking.scheduled_at },
      };
    } catch (err) {
      if (err instanceof BookingRejectedError) return await rejection(lang, business, booking, err.reason);
      throw err;
    }
  } catch (err) {
    log.error('reschedule.failed', { err });
    return { ok: false, message: say(lang, 'Let me have the owner call you to change that.', 'Voy a pedirle al dueño que le llame para cambiarla.'), data: { error: { tool: 'reschedule_booking', code: 'tool_error' } } };
  }
}

async function rejection(lang: Lang, business: Business, booking: Booking, reason: string): Promise<ToolOut> {
  const tz = tzOf(business);
  if (reason === 'slot_taken' || reason === 'calendar_busy' || reason === 'past' || reason === 'closed_day' || reason === 'closed_date' || reason === 'before_open' || reason === 'after_close' || reason === 'too_soon' || reason === 'too_far') {
    // Offer real alternatives from the calendar: the next free slots within two weeks.
    const alts: string[] = [];
    for (const d of upcomingDateKeys(Date.now(), tz, schedulingOf(business).horizon_days)) {
      for (const s of await slotsForMove(business, booking, d, Date.now(), { customer: true })) {
        if (s.available && !s.current) { alts.push(when(s.start, lang, tz)); if (alts.length >= 3) break; }
      }
      if (alts.length >= 3) break;
    }
    const why = reason === 'slot_taken' || reason === 'calendar_busy' ? say(lang, "That time isn't available.", 'Ese horario no está disponible.')
      : reason === 'past' ? say(lang, 'That time has already passed.', 'Esa hora ya pasó.')
      : say(lang, "We're not open then.", 'No abrimos a esa hora.');
    const tail = alts.length > 0
      ? say(lang, ` I can do ${alts.join(', or ')}. Which works?`, ` Puedo ${alts.join(', o ')}. ¿Cuál le queda bien?`)
      : say(lang, ` I do not have anything open in the next ${schedulingOf(business).horizon_days} days; I can have the owner call you.`, ` No tengo nada disponible en los próximos ${schedulingOf(business).horizon_days} días; puedo pedirle al dueño que le llame.`);
    return { ok: false, message: `${why}${tail}`, data: { reason, alternatives: alts.length } };
  }
  return { ok: false, message: say(lang, 'I could not move that one; let me have the owner call you.', 'No pude cambiarla; voy a pedirle al dueño que le llame.'), data: { reason } };
}

export async function cancelBookingTool(args: BookingToolArgs): Promise<ToolOut> {
  const lang = langOf(args.language);
  try {
    const business = args.business_id ? await getBusiness(str(args.business_id)) : null;
    if (!business) return { ok: false, message: say(lang, 'Let me get the owner for that — one moment.', 'Permítame conseguir al dueño — un momento.') };
    const tz = tzOf(business);
    const caller = await verifyCaller(business, args);
    if (!caller) return notVerified(lang, 'caller_not_verified');
    const picked = await pick(business, caller, args);
    if (picked.kind === 'none') return nothingFound(lang);
    if (picked.kind === 'ask') return askWhich(lang, tz, picked.options);
    const booking = picked.booking;
    const yes = args.confirmed === true || str(args.confirmed).toLowerCase() === 'true';
    if (!yes) {
      return {
        ok: false,
        message: say(lang, `Just to confirm: you want to cancel your ${booking.service} ${when(booking.scheduled_at, lang, tz)}. Is that right?`, `Para confirmar: quiere cancelar su cita de ${booking.service} ${when(booking.scheduled_at, lang, tz)}. ¿Es correcto?`),
        data: { reason: 'needs_confirmation' },
      };
    }
    const out = await cancelBooking({
      businessId: business.id, bookingId: booking.id, initiator: 'customer', language: lang, reason: str(args.reason).slice(0, 200) || 'cancelled by the caller on the phone',
      actor: { kind: 'system', meta: { source: 'voice', call_id: caller.call?.id ?? null } },
    });
    if (!out.ok) return nothingFound(lang);
    const paid = out.booking.deposit_paid && out.booking.deposit_amount ? out.booking.deposit_amount : 0;
    const money = formatCents(paid, { fractionalAlways: paid % 100 !== 0 });
    const deposit = paid <= 0 ? ''
      : out.refund.eligible
        ? say(lang, ` Your ${money} deposit is eligible for a refund; the owner will process it.`, ` Su depósito de ${money} es reembolsable; el dueño lo procesará.`)
        : say(lang, ` Under our policy the ${money} deposit is not refunded; I can have the owner call you if you have questions.`, ` Según nuestra política, el depósito de ${money} no es reembolsable; puedo pedirle al dueño que le llame si tiene dudas.`);
    if (!out.changed) return { ok: true, message: say(lang, 'That booking was already cancelled.', 'Esa cita ya estaba cancelada.'), data: { changed: false } };
    return {
      ok: true,
      message: say(lang, `Done. Your ${booking.service} ${when(booking.scheduled_at, lang, tz)} is cancelled.${deposit}${textClause(lang, out.notice)}`, `Listo. Su cita de ${booking.service} ${when(booking.scheduled_at, lang, tz)} quedó cancelada.${deposit}${textClause(lang, out.notice)}`),
      data: { changed: true, booking_id: booking.id, refund_eligible: out.refund.eligible },
    };
  } catch (err) {
    log.error('cancel.failed', { err });
    return { ok: false, message: say(lang, 'Let me have the owner call you to cancel that.', 'Voy a pedirle al dueño que le llame para cancelarla.'), data: { error: { tool: 'cancel_booking', code: 'tool_error' } } };
  }
}

/** ElevenLabs tool specs for the two tools (merged into TOOL_SPECS in voice/elevenlabs.ts). */
export const BOOKING_TOOL_SPECS: Record<BookingToolName, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  reschedule_booking: {
    description: "Move the CALLER'S OWN existing booking to a new time. Works only for a booking made with the number they are calling from; if it answers that it cannot, take a message with handoff_to_human instead. Offer times with check_availability first and confirm the new time with the caller before calling.",
    properties: {
      new_scheduled_at: { type: 'string', description: "The NEW start as LOCAL wall-clock time in the business's time zone, with NO UTC offset, e.g. 2026-11-15T15:00:00." },
      current_time: { type: 'string', description: 'Only when the caller has several upcoming bookings: the CURRENT start of the one to move, LOCAL wall-clock, no offset.' },
    },
    required: ['new_scheduled_at'],
  },
  cancel_booking: {
    description: "Cancel the CALLER'S OWN upcoming booking. Works only for a booking made with the number they are calling from; if it answers that it cannot, take a message with handoff_to_human. Ask the caller to confirm out loud first, then call with confirmed=true. Never promise a refund: say what the tool says about the deposit.",
    properties: {
      confirmed: { type: 'boolean', description: 'true ONLY after the caller clearly said yes to cancelling this booking.' },
      current_time: { type: 'string', description: 'Only when the caller has several upcoming bookings: the start of the one to cancel, LOCAL wall-clock, no offset.' },
      reason: { type: 'string', description: 'Why they are cancelling, in a few words (optional).' },
    },
    required: ['confirmed'],
  },
};
