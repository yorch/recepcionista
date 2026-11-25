/**
 * WS3 — the seven voice-agent tools. Every tool returns a spoken-ready
 * `message` in the caller's language and NEVER throws: a failed tool must
 * still leave the agent with something to say.
 *
 * Locale: English and Spanish for every path. Times are always rendered in
 * America/New_York, which is where the demo business lives.
 */
import { emitBookingChanged } from '@/lib/booking-hooks';
import {
  getBusiness, getKnowledgeBase, getBooking, createCall, findActiveCall, upsertCallForConversation,
  updateCall, setTransferStatus, createBooking as dbCreateBooking, BookingRejectedError,
} from '@/lib/db';
import { slotsForDate, nextAvailable } from '@/lib/scheduler';
import { clampDuration, DEFAULT_DURATION_MIN } from '@/lib/availability';
import {
  addDaysToDateKey, isDateKey, localDateKey, parseScheduledAt, partsInTz, spokenTimeInTz, tzOf,
} from '@/lib/time';
import { dollarsToCents, formatCents } from '@/lib/money';
import { logger } from '@/lib/log';
import { normalizePhone } from '@/lib/providers/twilio';
import { E164 } from '@/lib/messaging/recipient';
import { sendAndLog } from '@/lib/messaging';
import { smsDelivered as smsWasDelivered } from '@/lib/messaging/delivery';
import { SERVICE_ALIASES } from '@/lib/verticals/aliases';
import { CALL_911_EN, CALL_911_ES, call911For, call911Hazards } from '@/lib/voice/emergency';
import { alertField, alertOwner, type OwnerAlert } from '@/lib/voice/owner-alert';
import { makeT } from '@/lib/i18n';
import { ownerLocaleFor } from '@/lib/i18n/owner-locale';
import { isOwnerNumber } from '@/lib/messaging/owner';
import { countryForBusiness } from '@/lib/db';
import { TOOL_NAMES, type ToolName } from '@/lib/kb';
import { CAPACITY_EXEMPT_TOOLS, pausedToolMessage } from '@/lib/voice/capacity';
import { resolveCallRoute } from '@/lib/voice/call-mode';
import { cancelBookingTool, rescheduleBookingTool } from '@/lib/voice/tools-bookings';
import { decideTransfer, nativeTransferEnabled, noteTransferAttempt, transferApprovedMessage, transferRefusalMessage } from '@/lib/voice/transfer';

export { CALL_911_EN, CALL_911_ES };
import { createAndSendPaymentLink, sendConfirmation } from '@/lib/messaging/actions';
import type { Business, Call, SmsLog, TimeSlot } from '@/lib/types';

const log = logger('voice-tools');

export type ToolLanguage = 'en' | 'es';

export interface ToolResult {
  ok: boolean;
  /** The exact sentence the voice agent should say, in the caller's language. */
  message: string;
  data?: unknown;
}

interface BaseArgs {
  business_id?: string;
  call_id?: string;
  /** Telephony call SID, when the agent platform passes it (preferred way to find the live call). */
  call_sid?: string;
  /** Platform-supplied conversation id (system__conversation_id); doubles as the call key. */
  conversation_id?: string;
  /** Platform-supplied caller number (system__caller_id) — trusted, unlike anything the LLM says. */
  caller_phone?: string;
  language?: string;
}

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ---------------------------------------------------------------- language

function langOf(raw?: unknown): ToolLanguage {
  return typeof raw === 'string' && raw.toLowerCase().startsWith('es') ? 'es' : 'en';
}

function say(lang: ToolLanguage, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

// ------------------------------------------------------------- time strings

// All of these render in the BUSINESS zone (never the process zone).
function spokenTime(iso: string, tz: string): string {
  return spokenTimeInTz(iso, tz);
}

function dayPhrase(iso: string, lang: ToolLanguage, tz: string): string {
  const key = localDateKey(iso, tz);
  const todayKey = localDateKey(new Date(), tz);
  if (key === todayKey) return lang === 'es' ? 'hoy' : 'today';
  if (key === addDaysToDateKey(todayKey, 1)) return lang === 'es' ? 'mañana' : 'tomorrow';
  const idx = partsInTz(iso, tz).weekday;
  return lang === 'es' ? WEEKDAY_ES[idx] : WEEKDAY_EN[idx];
}

function whenPhrase(iso: string, lang: ToolLanguage, tz: string): string {
  const day = dayPhrase(iso, lang, tz);
  const time = spokenTime(iso, tz);
  return lang === 'es' ? `${day} a las ${time}` : `${day} at ${time}`;
}

function joinList(items: string[], conjunction: string, lang: ToolLanguage): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  // Spanish takes no serial comma; English does for a spoken list of three+.
  const head = items.slice(0, -1).join(', ');
  return lang === 'es'
    ? `${head} ${conjunction} ${items[items.length - 1]}`
    : `${head}, ${conjunction} ${items[items.length - 1]}`;
}

/** "tomorrow at 10 AM or 2 PM" — groups slots that share a day. */
function describeSlots(slots: TimeSlot[], lang: ToolLanguage, tz: string): string {
  const groups: { day: string; times: string[] }[] = [];
  for (const slot of slots) {
    const day = dayPhrase(slot.start, lang, tz);
    const time = spokenTime(slot.start, tz);
    const group = groups.find((g) => g.day === day);
    if (group) {
      if (!group.times.includes(time)) group.times.push(time);
    } else {
      groups.push({ day, times: [time] });
    }
  }
  const phrased = groups.map((g) => (
    lang === 'es'
      ? `${g.day} a las ${joinList(g.times, 'o', lang)}`
      : `${g.day} at ${joinList(g.times, 'or', lang)}`
  ));
  return joinList(phrased, lang === 'es' ? 'o' : 'or', lang);
}

/** A short "I could do X instead" clause built from the real calendar. */
async function alternativeClause(business: Business, lang: ToolLanguage, durationMinutes = DEFAULT_DURATION_MIN): Promise<string> {
  const slot = (await nextAvailable(business, 1, durationMinutes))[0];
  if (!slot) {
    return say(lang,
      'Nothing is open in the next two weeks.',
      'No hay nada disponible en las próximas dos semanas.');
  }
  return say(lang,
    `I can do ${whenPhrase(slot.start, lang, tzOf(business))} instead.`,
    `Puedo ${whenPhrase(slot.start, lang, tzOf(business))}.`);
}

/** Structured, loggable failure for a tool that threw. Never swallow: log, then return this. */
function toolFailure(
  tool: string, err: unknown, lang: ToolLanguage, message: string, extra: Record<string, unknown> = {},
): ToolResult {
  const detail = err instanceof Error ? err.message : String(err);
  log.error(`${tool}.failed`, { err });
  return { ok: false, message, data: { error: { tool, code: 'tool_error', message: detail }, ...extra } };
}

// ------------------------------------------------------------- infrastructure

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

async function resolveBusiness(args: BaseArgs): Promise<Business | null> {
  const id = str(args.business_id) || str((args as Record<string, unknown>).businessId);
  return id ? getBusiness(id) : null;
}

function missingBusiness(lang: ToolLanguage): ToolResult {
  return {
    ok: false,
    message: say(lang,
      'Let me get the owner for that — one moment.',
      'Permítame conseguir al dueño — un momento.'),
  };
}

/** Match by id, then SID / conversation id only. Never guesses by caller phone or "the latest call". */
async function activeCall(
  businessId: string,
  args: { call_id?: string; call_sid?: string; conversation_id?: string },
): Promise<Call | null> {
  return findActiveCall(businessId, {
    callId: str(args.call_id) || undefined,
    callSid: str(args.call_sid) || undefined,
    conversationId: str(args.conversation_id) || undefined,
  });
}

/** Strict E.164 (after US-style normalisation) or null. Country policy is enforced later, when texting. */
function cleanPhone(raw: unknown): string | null {
  const v = str(raw);
  if (!v) return null;
  const n = normalizePhone(v);
  return E164.test(n) ? n : null;
}

/**
 * The platform's caller id (`system__caller_id`). It is trusted ONLY because the request reached us
 * through the tool-secret-authenticated route and the schema binds the field to a platform dynamic
 * variable the model cannot write. Anything else the model relays (customer_phone, `to`) is not.
 */
function platformCaller(args: { caller_phone?: string }): string | null {
  return cleanPhone(args.caller_phone);
}

/** The number we may text for this call: the call row's caller, else the platform caller id. Never an LLM-relayed number. */
function verifiedCaller(call: Call | null, args: { caller_phone?: string }): string | null {
  return cleanPhone(call?.caller_phone) ?? platformCaller(args);
}

/**
 * The live call row for this tool call. A phone call that reached the agent natively has no row yet, so
 * the FIRST tool call creates one (keyed by call SID / conversation id, storing the platform caller id):
 * from then on matching, the per-call cap and consent all hang off one row. Null only when the platform
 * supplied no key at all.
 */
async function resolveCall(
  business: Business,
  args: { call_id?: string; call_sid?: string; conversation_id?: string; caller_phone?: string },
): Promise<Call | null> {
  const sid = str(args.call_sid);
  const conv = str(args.conversation_id);
  const found = await activeCall(business.id, args);
  if (!found) {
    return upsertCallForConversation(business.id, { callSid: sid, conversationId: conv, callerPhone: platformCaller(args) });
  }
  const patch: Partial<Call> = {};
  if (sid && !found.call_sid && found.conversation_id !== sid) patch.call_sid = sid;
  if (conv && !found.conversation_id && found.call_sid !== conv) patch.conversation_id = conv;
  const callerId = platformCaller(args);
  if (callerId && !found.caller_phone) patch.caller_phone = callerId;
  return Object.keys(patch).length > 0 ? ((await updateCall(found.id, patch)) ?? found) : found;
}

/** Policy knob: text the model-relayed booking phone when NO verified caller number exists. Default: never. */
function allowUnverifiedBookingSms(): boolean {
  return process.env.ALLOW_UNVERIFIED_BOOKING_SMS === 'true';
}

export type { OwnerAlert };

/** What to tell a caller when we could NOT reach the owner. */
function ownerFallback(business: Business, lang: ToolLanguage, emergency: boolean): { message: string; data: Record<string, unknown> } {
  const phone = business.owner_phone ? normalizePhone(business.owner_phone) : null;
  const copy911 = call911For(business);
  const call911 = say(lang, copy911.en, copy911.es);
  const owner = phone
    ? say(lang, `You can also call the owner directly at ${phone}.`, `También puede llamar al dueño directamente al ${phone}.`)
    : say(lang, 'I will keep trying to reach the owner and they will call you back.', 'Voy a seguir intentando comunicarme con el dueño y él le devolverá la llamada.');
  return {
    message: emergency ? `${call911} ${owner}` : owner,
    data: { call_911_for: call911Hazards(business), owner_phone: phone },
  };
}

// ------------------------------------------------------------------- tools

/**
 * One duration rule for BOTH check_availability and create_booking, so a slot
 * that was offered is a slot that can be booked: explicit minutes, else the
 * matched catalog service's length, else the default.
 */
async function resolveDuration(businessId: string, service: string, explicit?: unknown): Promise<number> {
  const kb = service ? await getKnowledgeBase(businessId) : null;
  const matched = kb && service ? matchService(kb.services, service)[0] : undefined;
  const hasExplicit = explicit != null && str(explicit) !== '';
  return clampDuration(hasExplicit ? explicit : matched?.duration_minutes, DEFAULT_DURATION_MIN);
}

/** Max bookings one phone call may create (stops one call from filling the calendar / pumping SMS). */
const MAX_BOOKINGS_PER_CALL = 2;

export interface CheckAvailabilityArgs extends BaseArgs {
  service?: string;
  date?: string;
  duration_minutes?: number | string;
}

export async function checkAvailability(args: CheckAvailabilityArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);
    const tz = tzOf(business);

    const duration = await resolveDuration(business.id, str(args.service), args.duration_minutes);
    const requested = str(args.date);
    let dateStr = '';
    if (requested) {
      if (isDateKey(requested)) {
        dateStr = requested;
      } else {
        // Accept a full datetime and take its local date; reject anything else so the agent re-asks.
        const parsed = parseScheduledAt(requested, tz);
        if (!parsed.ok) {
          return {
            ok: false,
            message: say(lang,
              'Which day did you have in mind? Please give me the date.',
              '¿Qué día tenía en mente? Deme la fecha, por favor.'),
            data: { reason: 'invalid_date', received: requested },
          };
        }
        dateStr = localDateKey(parsed.date, tz);
      }
    }

    let slots: TimeSlot[];
    let dayFull = false;
    if (dateStr) {
      slots = (await slotsForDate(business, dateStr, duration)).filter((s) => s.available).slice(0, 3);
      if (slots.length === 0) {
        dayFull = true;
        slots = await nextAvailable(business, 3, duration);
      }
    } else {
      slots = await nextAvailable(business, 3, duration);
    }

    if (slots.length === 0) {
      return {
        ok: false,
        message: say(lang,
          'I do not have anything open in the next two weeks — let me have the owner call you with times.',
          'No tengo nada disponible en las próximas dos semanas — voy a pedirle al dueño que le llame con horarios.'),
        data: { slots: [] },
      };
    }

    const list = describeSlots(slots, lang, tz);
    const multiple = slots.length > 1;
    const prefix = dayFull
      ? say(lang, `That day is full, but I have ${list}`, `Ese día está lleno, pero tengo ${list}`)
      : say(lang, `I have ${list}`, `Tengo ${list}`);
    const message = multiple
      ? say(lang, `${prefix} — which works better?`, `${prefix} — ¿cuál le queda mejor?`)
      : say(lang, `${prefix} open — does that work for you?`, `${prefix} disponible — ¿le queda bien?`);

    return { ok: true, message, data: { slots, timezone: tz } };
  } catch (err) {
    return toolFailure('check_availability', err, lang, say(lang,
      'Let me check the calendar with the owner and call you right back.',
      'Déjeme revisar el calendario con el dueño y le llamo ahora.'));
  }
}

export interface CreateBookingArgs extends BaseArgs {
  customer_name?: string;
  customer_phone?: string;
  service?: string;
  /** Local wall-clock ISO in the business zone ("2026-11-24T10:00:00") or with an explicit offset. */
  scheduled_at?: string;
  duration_minutes?: number | string;
  address?: string;
  /** DOLLARS, as the agent speaks them; stored as integer cents. */
  price_estimate?: number | string;
}

const MAX_PRICE_CENTS = 10_000_000; // $100k sanity cap

/** Ask only for what is actually missing; a phone number only when caller id is withheld (otherwise it is already known). */
export function missingBookingFields(lang: ToolLanguage, m: { name: boolean; phone: boolean; service: boolean; scheduled_at: boolean }): string {
  const en: string[] = [];
  const es: string[] = [];
  if (m.name) { en.push('your name'); es.push('su nombre'); }
  if (m.phone) { en.push('a number to reach you on (I cannot see the number you are calling from)'); es.push('un número para llamarle (no veo el número desde el que llama)'); }
  if (m.service) { en.push('which service you need'); es.push('qué servicio necesita'); }
  if (m.scheduled_at) { en.push('which day and time works'); es.push('qué día y hora le queda bien'); }
  const join = (xs: string[], and: string) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
  return say(lang, `I just need ${join(en, 'and')}.`, `Solo necesito ${join(es, 'y')}.`);
}

export async function createBooking(args: CreateBookingArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);
    const tz = tzOf(business);

    // The call row first: it carries the verified caller number and the per-call cap key.
    const call = await resolveCall(business, args);
    const verified = verifiedCaller(call, args);

    const name = str(args.customer_name);
    // The relayed callback number is only the booking CONTACT; it is stored, never texted (see below).
    const phone = str(args.customer_phone) || verified || '';
    const service = str(args.service);
    const scheduledAt = str(args.scheduled_at);

    if (!name || !phone || !service || !scheduledAt) {
      return {
        ok: false,
        message: missingBookingFields(lang, { name: !name, phone: !phone, service: !service, scheduled_at: !scheduledAt }),
        data: { missing: { name: !name, phone: !phone, service: !service, scheduled_at: !scheduledAt } },
      };
    }

    // Offset-less strings are wall-clock time in the BUSINESS zone, never UTC.
    const parsed = parseScheduledAt(scheduledAt, tz);
    if (!parsed.ok) {
      return {
        ok: false,
        message: say(lang,
          'I did not catch that day and time — can you say it again?',
          'No le entendí la fecha y la hora — ¿me la repite?'),
        data: { reason: 'invalid_time', detail: parsed.reason, received: scheduledAt },
      };
    }
    const iso = parsed.date.toISOString();

    // Length of the job: same rule check_availability used for the offered slot.
    const duration = await resolveDuration(business.id, service, args.duration_minutes);

    // No platform key (call SID / conversation id) and no call row: nothing to hang the per-call cap on, so refuse.
    if (!call) {
      log.warn('create_booking.no_call_key', { business: business.id });
      return {
        ok: false,
        message: say(lang,
          'I could not put that in the calendar from here — let me have the owner confirm it with you.',
          'No pude agendarlo desde aquí — voy a pedirle al dueño que se lo confirme.'),
        data: { reason: 'no_call_key' },
      };
    }

    const priceDollars = args.price_estimate == null || str(args.price_estimate) === ''
      ? null
      : dollarsToCents(args.price_estimate);
    const priceEstimate = priceDollars == null ? null : Math.min(MAX_PRICE_CENTS, Math.max(0, priceDollars));

    // Prefer the catalog's own name over free text the caller (or an injected prompt) made up.
    const kbForName = await getKnowledgeBase(business.id);
    const catalogName = (kbForName ? matchService(kbForName.services, service)[0]?.name : undefined) ?? service;

    let booking;
    try {
      booking = await dbCreateBooking({
        business_id: business.id,
        call_id: call.id,
        customer_name: name,
        customer_phone: normalizePhone(phone),
        service: catalogName,
        scheduled_at: iso,
        duration_minutes: duration,
        address: str(args.address) || null,
        price_estimate: priceEstimate,
      }, { max_per_call: MAX_BOOKINGS_PER_CALL });
    } catch (err) {
      if (err instanceof BookingRejectedError && err.reason === 'no_call') {
        return { ok: false, message: say(lang,
          'I could not put that in the calendar from here — let me have the owner confirm it with you.',
          'No pude agendarlo desde aquí — voy a pedirle al dueño que se lo confirme.'), data: { reason: 'no_call_key' } };
      }
      if (err instanceof BookingRejectedError && err.reason === 'call_cap') {
        return {
          ok: false,
          message: say(lang,
            'I have already booked two appointments on this call — let me have the owner help with anything else.',
            'Ya agendé dos citas en esta llamada — voy a pedirle al dueño que le ayude con lo demás.'),
          data: { reason: 'booking_cap' },
        };
      }
      if (err instanceof BookingRejectedError) return await rejectionResult(err.reason, business, lang, duration, iso);
      throw err;
    }

    await emitBookingChanged(booking.id, 'created', business.id); // Google Calendar push etc. (fire-and-forget handlers, never throws)
    if (!call.caller_name) await updateCall(call.id, { caller_name: name });

    // The confirmation goes to the VERIFIED caller number (call row / platform caller id), in the language
    // they called in. The relayed contact number is texted only when it is that same number, or when
    // operator policy explicitly allows texting an unverified one (ALLOW_UNVERIFIED_BOOKING_SMS).
    const textTo = verified ?? (allowUnverifiedBookingSms() ? booking.customer_phone : null);
    let sms: unknown | null = null;
    let smsDelivered = false;
    if (textTo) {
      try {
        const confirmation = await sendConfirmation(booking.id, lang, { to: textTo });
        sms = confirmation;
        smsDelivered = smsWasDelivered(confirmation.sms.status);
      } catch (err) {
        log.warn('confirmation.failed', { booking: booking.id, err });
      }
    }

    return {
      ok: true,
      message: smsDelivered
        ? say(lang,
          `You're all set for ${whenPhrase(iso, lang, tz)}. I'm sending your confirmation text now.`,
          `Listo, quedó agendado para ${whenPhrase(iso, lang, tz)}. Le mando el texto de confirmación ahora.`)
        : say(lang,
          `You're all set for ${whenPhrase(iso, lang, tz)}.`,
          `Listo, quedó agendado para ${whenPhrase(iso, lang, tz)}.`),
      data: { booking, sms_sent: smsDelivered, sms_blocked: sms != null && !smsDelivered },
    };
  } catch (err) {
    return toolFailure('create_booking', err, lang, say(lang,
      'I had trouble putting that in the calendar — let me have the owner confirm it with you.',
      'Tuve un problema agendando eso — voy a pedirle al dueño que se lo confirme.'));
  }
}

/** Friendly "offer alternatives" answer for every way a booking can be refused. */
async function rejectionResult(
  reason: string, business: Business, lang: ToolLanguage, duration: number, iso: string,
): Promise<ToolResult> {
  const alt = await alternativeClause(business, lang, duration);
  const data = { reason, scheduled_at: iso };
  switch (reason) {
    case 'slot_taken':
      return { ok: false, data, message: say(lang,
        `That slot just got taken. ${alt}`, `Ese horario se acaba de ocupar. ${alt}`) };
    case 'calendar_busy': // the owner has something on their own calendar then; never say what
      return { ok: false, data, message: say(lang,
        `We are not available at that time. ${alt}`, `No estamos disponibles a esa hora. ${alt}`) };
    case 'past':
      return { ok: false, data, message: say(lang,
        `That time has already passed. ${alt}`, `Esa hora ya pasó. ${alt}`) };
    case 'after_close':
      return { ok: false, data, message: say(lang,
        `That job would run past our closing time. ${alt}`,
        `Ese trabajo terminaría después de nuestra hora de cierre. ${alt}`) };
    case 'closed_day':
    case 'closed_date':
    case 'before_open':
      return { ok: false, data, message: say(lang,
        `That is outside our hours. ${alt}`, `Eso está fuera de nuestro horario. ${alt}`) };
    default:
      return { ok: false, data, message: say(lang,
        `I cannot fit that one in. ${alt}`, `No puedo acomodar esa hora. ${alt}`) };
  }
}

export interface SendSmsArgs extends BaseArgs {
  to?: string;
  body?: string;
}

export async function sendSmsTool(args: SendSmsArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const body = str(args.body);
    if (!body) {
      return {
        ok: false,
        message: say(lang,
          'I need the message text before I can send that.',
          'Necesito el texto del mensaje antes de poder mandarlo.'),
      };
    }

    // The recipient is NEVER taken from the model: only this call's caller or the owner.
    // (`to` merely selects between those two.)
    const call = await resolveCall(business, args);
    const callerPhone = verifiedCaller(call, args) ?? '';
    const country = countryForBusiness(business);
    const wanted = str(args.to);
    const to = wanted && business.owner_phone
      && (wanted.toLowerCase() === 'owner' || isOwnerNumber(business, wanted, country))
      ? business.owner_phone
      : callerPhone;
    if (!to) {
      return {
        ok: false,
        message: say(lang,
          'I do not have a number I can text from here — let me read you the details instead.',
          'No tengo un número al cual mandar el texto — mejor se lo leo por teléfono.'),
      };
    }

    const toOwner = Boolean(business.owner_phone) && isOwnerNumber(business, to, country);
    const { sms: log, result: sent, blocked } = await sendAndLog({
      business_id: business.id, to, body, kind: toOwner ? 'owner_alert' : 'other',
    });

    if (blocked === 'blocked_opt_out') {
      return {
        ok: false,
        message: say(lang,
          'This number has opted out of texts, so I cannot send one — let me read you the details instead.',
          'Este número pidió no recibir textos, así que no puedo mandarlo — mejor se los leo por teléfono.'),
        data: { sms: log, blocked },
      };
    }

    if (blocked === 'blocked_cap' || blocked === 'blocked_owner_unverified') {
      return {
        ok: false,
        message: say(lang,
          'I cannot send a text from here right now — let me read you the details instead.',
          'No puedo mandar un texto desde aquí en este momento — mejor se los leo por teléfono.'),
        data: { sms: log, blocked },
      };
    }

    if (sent.status === 'failed' || !smsWasDelivered(log.status)) {
      return {
        ok: false,
        message: say(lang,
          'The text did not go through — let me read you the details instead.',
          'El texto no salió — mejor se los leo por teléfono.'),
        data: { sms: log, error: sent.error ?? null },
      };
    }

    return {
      ok: true,
      message: say(lang, 'I just sent that text to you.', 'Le acabo de mandar ese texto.'),
      data: { sms: log },
    };
  } catch (err) {
    return toolFailure('send_sms', err, lang, say(lang,
      'I could not send that text — let me read it to you instead.',
      'No pude mandar el texto — mejor se lo leo por teléfono.'));
  }
}

const DEPOSIT_CAP_CENTS = 50_000;

export interface CreatePaymentLinkArgs extends BaseArgs {
  amount_cents?: number | string;
  description?: string;
  booking_id?: string;
}

export async function createPaymentLink(args: CreatePaymentLinkArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const requested = Math.round(Number(args.amount_cents));
    if (!Number.isFinite(requested) || requested <= 0) {
      return {
        ok: false,
        message: say(lang,
          'How much should the deposit be for?',
          '¿De cuánto sería el depósito?'),
      };
    }
    if (requested < 100) {
      // Cents expected (18900 = $189). A value under $1 is almost certainly dollars: re-ask rather than make a $1.89 link.
      return {
        ok: false,
        message: say(lang,
          'Let me double check the deposit amount. How much should it be?',
          'Déjeme confirmar el monto del depósito. ¿De cuánto sería?'),
        data: { reason: 'amount_below_minimum', received: requested },
      };
    }
    const capped = requested > DEPOSIT_CAP_CENTS;
    const amountCents = capped ? DEPOSIT_CAP_CENTS : requested;
    const description = str(args.description) || 'Service deposit';

    const bookingId = str(args.booking_id);
    const found = bookingId ? await getBooking(bookingId) : null;
    const booking = found && found.business_id === business.id ? found : null;
    const call = await resolveCall(business, args);
    // Recipient is never taken from the model: this call's verified caller number, or (only when there is none)
    // the number on a booking that was made on THIS call.
    const to = normalizePhone(
      verifiedCaller(call, args) || (booking && call && booking.call_id === call.id ? booking.customer_phone : '') || '',
    );
    if (!to) {
      return {
        ok: false,
        message: say(lang,
          'What number should I text the payment link to?',
          '¿A qué número le mando el enlace de pago?'),
      };
    }

    // One call, one link: the library creates the link, records the deposit (cents) and texts it.
    let sms: SmsLog | null = null;
    let link: { id: string; url: string; amount_cents: number; mock: boolean } | null = null;
    try {
      const sent = await createAndSendPaymentLink({
        business, booking, to, amountCents, description, language: lang,
      });
      sms = sent.sms;
      link = sent.link;
    } catch (err) {
      return toolFailure('create_payment_link', err, lang, say(lang,
        'I could not create that payment link — let me have the owner call you to take the deposit.',
        'No pude crear el enlace de pago — voy a pedirle al dueño que le llame para el depósito.'));
    }

    const spoken = formatCents(amountCents);
    if (sms && !smsWasDelivered(sms.status)) {
      // The link exists but the text was blocked (opt-out, plan cap, ...): never claim it is on its way.
      return {
        ok: false,
        message: say(lang,
          'I could not text that link from here — let me have the owner call you to take the deposit.',
          'No pude mandar ese enlace por texto — voy a pedirle al dueño que le llame para el depósito.'),
        data: { amount_cents: amountCents, sms_sent: false, blocked: sms.status },
      };
    }
    return {
      ok: true,
      message: say(lang,
        `I'm sending you a secure link for the ${spoken} deposit right now.`,
        `Le estoy mandando un enlace seguro para el depósito de ${spoken} ahora mismo.`),
      data: {
        link,
        amount_cents: amountCents,
        capped,
        sms_sent: sms != null,
        sms_target: to || null,
      },
    };
  } catch (err) {
    return toolFailure('create_payment_link', err, lang, say(lang,
      'I could not create that payment link — let me have the owner call you to take the deposit.',
      'No pude crear el enlace de pago — voy a pedirle al dueño que le llame para el depósito.'));
  }
}

export interface FlagEmergencyArgs extends BaseArgs {
  reason?: string;
  customer_name?: string;
  customer_phone?: string;
  address?: string;
}

export async function flagEmergency(args: FlagEmergencyArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const reason = alertField(str(args.reason), 300) || 'Emergency reported on call';
    const callerName = str(args.customer_name);
    const callerPhone = str(args.customer_phone);
    const address = str(args.address);

    let call = await resolveCall(business, args);
    if (!call) {
      // No platform key at all (e.g. a tool call from the demo simulator): still record the emergency.
      call = await createCall({
        business_id: business.id,
        caller_phone: platformCaller(args),
        caller_name: callerName || null,
        status: 'in_progress',
      });
    }

    const updated = await updateCall(call.id, {
      urgency: 'emergency',
      flagged_reason: reason,
      ...(callerName && !call.caller_name ? { caller_name: callerName } : {}),
      // call.caller_phone is only ever set from the platform caller id; the relayed number appears in the alert text only.
    });

    // Caller-controlled text is clamped field by field (the whole alert is also capped at 320 GSM-safe characters by alertOwner).
    const ot = makeT(await ownerLocaleFor(business));
    const alertBody = [
      ot('alert.emergency.title', { business: alertField(business.name, 50) }),
      callerName ? ot('alert.caller', { name: alertField(callerName, 50) }) : '',
      callerPhone ? ot('alert.phone', { phone: alertField(normalizePhone(callerPhone), 20) }) : call.caller_phone ? ot('alert.phone', { phone: call.caller_phone }) : '',
      address ? ot('alert.address', { address: alertField(address, 100) }) : '',
      ot('alert.reason', { reason: alertField(reason, 140) }),
      ot('alert.callbackNow'),
    ].filter(Boolean).join('\n');
    const alert = await alertOwner(business, alertBody, { class: 'emergency', callId: call.id });

    if (alert.notified) {
      return {
        ok: true,
        message: say(lang,
          `${call911For(business).en} I've flagged this as an emergency and the owner has been notified.`,
          `${call911For(business).es} Lo marqué como emergencia y el dueño ya fue notificado.`),
        data: { call: updated, owner_sms: alert.sms, owner_notified: true },
      };
    }

    // Be honest: the emergency is recorded, but nobody was actually alerted.
    const fb = ownerFallback(business, lang, true);
    log.error('flag_emergency.owner_not_notified', { business: business.id, call: call.id, why: alert.reason });
    return {
      ok: false,
      message: say(lang,
        `I've recorded this as an emergency, but I could not reach the owner just now. ${fb.message}`,
        `Registré esto como emergencia, pero no pude comunicarme con el dueño ahora mismo. ${fb.message}`),
      data: { call: updated, owner_sms: alert.sms, owner_notified: false, notify_failure: alert.reason, fallback: fb.data },
    };
  } catch (err) {
    const business = await resolveBusiness(args).catch(() => null);
    const fb = business ? ownerFallback(business, lang, true) : null;
    return toolFailure('flag_emergency', err, lang, say(lang,
      `I could not alert the owner. ${fb?.message ?? 'If there is gas, carbon monoxide, smoke or fire, call 911 now; otherwise please call the business directly.'}`,
      `No pude avisarle al dueño. ${fb?.message ?? 'Si hay gas, monóxido de carbono, humo o fuego, llame al 911 ahora; si no, por favor llame directamente al negocio.'}`),
    { owner_notified: false, fallback: fb?.data ?? { call_911_for: ['gas', 'carbon_monoxide', 'smoke', 'fire'] } });
  }
}

function normalizeQuery(query: string, aliases = true): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (aliases ? SERVICE_ALIASES[w] ?? w : w))
    .join(' ');
}

function matchService<T extends { name: string }>(services: T[], query: string): T[] {
  const q = normalizeQuery(query).trim();
  if (!q) return services;
  // The query as spoken is scored too: a service named in Spanish ("Limpieza profunda") must match the Spanish words, not only their English aliases.
  const queries = [...new Set([q, normalizeQuery(query, false).trim()].filter(Boolean))];
  const scoreOf = (name: string, query2: string): number => {
    const words = query2.split(/\s+/).filter((w) => w.length > 2);
    if (name === query2) return 100;
    if (name.includes(query2)) return 80;
    if (query2.includes(name)) return 70;
    return words.filter((w) => name.includes(w)).length * 20;
  };
  const scored = services
    .map((s) => {
      const name = s.name.toLowerCase();
      return { s, score: Math.max(...queries.map((q2) => scoreOf(name, q2))) };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((row) => row.s);
}

export interface GetPricingArgs extends BaseArgs {
  service_name?: string;
}

export async function getPricing(args: GetPricingArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const kb = await getKnowledgeBase(business.id);
    const services = kb?.services ?? [];
    if (services.length === 0) {
      return {
        ok: true,
        message: say(lang,
          "I'll have the owner confirm that price for you.",
          'Voy a pedirle al dueño que le confirme ese precio.'),
        data: { matched: false, price: null, service: null },
      };
    }

    const query = str(args.service_name);
    const hits = matchService(services, query);
    const match = hits[0] ?? null;
    const priced = match?.base_price;

    if (!match || priced == null) {
      return {
        ok: true,
        message: say(lang,
          "I'll have the owner confirm that price for you.",
          'Voy a pedirle al dueño que le confirme ese precio.'),
        data: {
          matched: Boolean(match),
          price: null,
          service: match?.name ?? null,
          candidates: hits.slice(0, 3).map((s) => s.name),
          note: 'Never invent a price — owner confirms.',
        },
      };
    }

    return {
      ok: true,
      message: say(lang,
        `${match.name} starts at ${formatCents(dollarsToCents(priced))}. The technician confirms the exact price on site.`,
        `${match.name} empieza en ${formatCents(dollarsToCents(priced))}. El técnico confirma el precio exacto en el lugar.`),
      data: {
        matched: true,
        price: priced,
        service: match.name,
        description: match.description ?? null,
        pricing_notes: kb?.pricing_notes ?? null,
      },
    };
  } catch (err) {
    log.error('get_pricing.failed', { err });
    return {
      ok: true,
      message: say(lang,
        "I'll have the owner confirm that price for you.",
        'Voy a pedirle al dueño que le confirme ese precio.'),
      data: { matched: false, price: null, error: { tool: 'get_pricing', code: 'tool_error', message: err instanceof Error ? err.message : String(err) } },
    };
  }
}

export interface HandoffArgs extends BaseArgs {
  reason?: string;
  /** A DIFFERENT number the caller asked to be called back on. Relayed by the model, so it is passed to the owner as "caller said", never used for texting. */
  callback_number?: string;
  /** True when the caller objected to the AI / recording: mark consent declined and take a message. */
  consent_declined?: boolean | string;
}

export async function handoffToHuman(args: HandoffArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const reason = alertField(str(args.reason), 300) || 'Caller asked for a human';
    let call = await resolveCall(business, args);
    if (!call) call = await createCall({ business_id: business.id, caller_phone: platformCaller(args), status: 'in_progress' });

    const declined = args.consent_declined === true || String(args.consent_declined).toLowerCase() === 'true';
    const updated = await updateCall(call.id, {
      status: 'handed_off',
      flagged_reason: reason,
      // Post-call processing stores no transcript/summary for declined calls.
      ...(declined ? { consent_status: 'declined' as const } : {}),
    });

    // The number the call came from is already known (platform caller id): confirm it instead of asking for it again.
    // Only a number the caller VOLUNTEERED as an alternative is relayed (labelled as such), and only when it is a real number.
    const verified = verifiedCaller(updated ?? call, args);
    const alt = cleanPhone(args.callback_number);
    const altDiffers = Boolean(alt && alt !== verified);
    const callbackLast4 = altDiffers ? alt!.slice(-4) : verified ? verified.slice(-4) : null;

    const ot = makeT(await ownerLocaleFor(business));
    const alertBody = [
      ot('alert.handoff.title', { business: alertField(business.name, 50) }),
      call.caller_name ? ot('alert.caller', { name: alertField(call.caller_name, 50) }) : '',
      call.caller_phone ? ot('alert.phone', { phone: call.caller_phone }) : verified ? ot('alert.phone', { phone: verified }) : '',
      altDiffers ? ot('alert.callbackOn', { phone: alt ?? '' }) : '',
      ot('alert.reason', { reason: alertField(reason, 140) }),
      ot('alert.callbackPlease'),
    ].filter(Boolean).join('\n');
    const alert = await alertOwner(business, alertBody, { class: 'handoff', callId: call.id });

    if (alert.notified) {
      // This does NOT transfer the line: the owner was texted and will call back.
      return {
        ok: true,
        message: declined ? say(lang,
          "Understood — we won't keep a transcript of this call. I've sent the owner a message and they will call you back.",
          'Entendido — no guardaremos una transcripción de esta llamada. Le envié un mensaje al dueño y le devolverá la llamada.')
        : callbackLast4
          ? say(lang,
            `I've sent the owner an urgent message and they will call you back shortly on the number ${altDiffers ? 'you gave me' : "you're calling from"}, ending in ${callbackLast4}. If a different number is better, tell me and I'll pass it on.`,
            `Le envié un mensaje urgente al dueño y le devolverá la llamada pronto al número ${altDiffers ? 'que me dio' : 'desde el que llama'}, que termina en ${callbackLast4}. Si le queda mejor otro número, dígamelo y se lo paso.`)
          // Caller id withheld: only then is asking for a number necessary.
          : say(lang,
            "I've sent the owner an urgent message and they will call you back shortly. I can't see your number: what is the best number to reach you?",
            'Le envié un mensaje urgente al dueño y le devolverá la llamada pronto. No veo su número: ¿cuál es el mejor número para localizarle?'),
        data: { call: updated, owner_sms: alert.sms, owner_notified: true, transferred: false, callback_number_known: Boolean(callbackLast4) },
      };
    }

    const fb = ownerFallback(business, lang, false);
    log.error('handoff.owner_not_notified', { business: business.id, call: call.id, why: alert.reason });
    return {
      ok: false,
      message: say(lang,
        `I have noted your request, but I could not reach the owner just now. ${fb.message}`,
        `Anoté su solicitud, pero no pude comunicarme con el dueño ahora mismo. ${fb.message}`),
      data: { call: updated, owner_sms: alert.sms, owner_notified: false, transferred: false, notify_failure: alert.reason, fallback: fb.data },
    };
  } catch (err) {
    return toolFailure('handoff_to_human', err, lang, say(lang,
      'I could not reach the owner just now — please call the business directly, or I can take a message.',
      'No pude comunicarme con el dueño ahora — por favor llame directamente al negocio, o puedo tomar un mensaje.'),
    { owner_notified: false });
  }
}

// --------------------------------------------------------------- dispatcher

export { TOOL_NAMES, type ToolName };

/** ElevenLabs may send "Check Availability", "checkAvailability", etc. */
function canonicalTool(raw: string): ToolName | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const direct = TOOL_NAMES.find((t) => t === key);
  if (direct) return direct;
  const compact = key.replace(/_/g, '');
  return TOOL_NAMES.find((t) => t.replace(/_/g, '') === compact) ?? null;
}

/**
 * Call handling gate: while calls are PAUSED (or a 'forward' is due on this AI line, where it can only be the paused script) the agent
 * must not book, quote, text or take payment: every tool except the message-taking ones (CAPACITY_EXEMPT_TOOLS: handoff_to_human,
 * flag_emergency) is refused with an honest spoken line. The decision is the same resolveCallRoute the initiation webhook uses, on the
 * 'native' line (a tool call IS an AI conversation), so the script the caller hears and what the tools allow can never disagree; an
 * after-hours schedule (forward only during business hours) therefore leaves the AI fully working outside those hours.
 */
async function callHandlingRefusal(businessId: unknown, lang: ToolLanguage): Promise<ToolResult | null> {
  if (typeof businessId !== 'string' || !businessId) return null;
  const business = await getBusiness(businessId);
  if (!business) return null; // each tool reports an unknown business itself
  const route = resolveCallRoute(business, new Date(), 'native');
  if (route.action === 'ai') return null;
  return { ok: false, message: pausedToolMessage(lang), data: { reason: 'calls_paused', route: route.action } };
}

/**
 * transfer_to_human: the AI asks for a live transfer (NATIVE_TRANSFER=on). Re-checks the verified number, hours, caps and concurrency (the
 * forward machinery) and charges the allowance; approved -> the agent then calls the transfer system tool; anything else (flag off,
 * outside hours, unverified number, caps, limits) -> the owner is texted a callback request (handoff_to_human) and the caller is told so.
 */
async function transferToHuman(args: HandoffArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  const es = lang === 'es';
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);
    const call = await resolveCall(business, args);
    const decision = nativeTransferEnabled()
      ? await decideTransfer(business, { callSid: call?.call_sid ?? str(args.call_sid), from: call?.caller_phone ?? platformCaller(args), stirStatus: call?.stir_status ?? null })
      : ({ ok: false, why: 'disabled' } as const);
    if (decision.ok) {
      if (call) await noteTransferAttempt(call.id);
      log.info('transfer.approved', { business: business.id, call: call?.id });
      return { ok: true, message: transferApprovedMessage(es), data: { approved: true } };
    }
    log.info('transfer.refused', { business: business.id, call: call?.id, why: decision.why });
    if (call && decision.why !== 'disabled') { try { await setTransferStatus(call.id, 'failed'); } catch { /* best-effort */ } }
    const fallback = await handoffToHuman({ ...args, reason: `Caller asked for a person; live transfer not available (${decision.why.replace(/_/g, ' ')})` });
    return { ok: false, message: `${transferRefusalMessage(decision.why, es)}${fallback.message}`, data: { approved: false, why: decision.why } };
  } catch (err) {
    log.error('transfer.failed', { err });
    return { ok: false, message: say(lang, 'I cannot transfer the call right now. Let me take a message for the owner.', 'No puedo transferir la llamada ahora. Permítame tomar un mensaje para el dueño.') };
  }
}

/** Single entry point for the HTTP route. Never throws. */
export async function runTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = canonicalTool(name);
  const lang = langOf(args?.language as string | undefined);
  const started = Date.now();
  const fields = {
    tool: tool ?? name,
    business: (args?.business_id as string | undefined) ?? undefined,
    args: Object.keys(args).filter((k) => k !== 'business_id').join(','),
  };
  if (!tool) {
    log.warn('unknown', { ...fields, ms: Date.now() - started });
    return {
      ok: false,
      message: say(lang, 'Let me get the owner for that.', 'Permítame conseguir al dueño para eso.'),
    };
  }
  const a = (args ?? {}) as Record<string, never>; // NOTE: loosely typed LLM args; each tool validates its own fields
  try {
    const result = await (async (): Promise<ToolResult> => {
      if (!CAPACITY_EXEMPT_TOOLS.has(tool) && tool !== 'transfer_to_human') {
        const refused = await callHandlingRefusal((a as Record<string, unknown>).business_id, lang);
        if (refused) return refused;
      }
      switch (tool) {
        case 'check_availability': return await checkAvailability(a);
        case 'create_booking': return await createBooking(a);
        case 'send_sms': return await sendSmsTool(a);
        case 'create_payment_link': return await createPaymentLink(a);
        case 'flag_emergency': return await flagEmergency(a);
        case 'get_pricing': return await getPricing(a);
        case 'handoff_to_human': return await handoffToHuman(a);
        case 'reschedule_booking': return await rescheduleBookingTool(a);
        case 'cancel_booking': return await cancelBookingTool(a);
        case 'transfer_to_human': return await transferToHuman(a);
        default:
          return {
            ok: false,
            message: say(lang, 'Let me get the owner for that.', 'Permítame conseguir al dueño para eso.'),
          };
      }
    })();
    const at = result.ok ? 'info' : 'warn';
    log[at]('call', { ...fields, ok: result.ok, ms: Date.now() - started });
    return result;
  } catch (err) {
    // Used to be a bare `catch {}`: the agent said "let me get the owner" and the
    // reason (bad args, DB down, provider 500) disappeared.
    log.error('call.failed', { ...fields, ms: Date.now() - started, err });
    return {
      ok: false,
      message: say(lang,
        'Let me get the owner for that.',
        'Permítame conseguir al dueño para eso.'),
    };
  }
}

