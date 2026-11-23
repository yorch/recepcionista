/**
 * WS3 — the seven voice-agent tools. Every tool returns a spoken-ready
 * `message` in the caller's language and NEVER throws: a failed tool must
 * still leave the agent with something to say.
 *
 * Locale: English and Spanish for every path. Times are always rendered in
 * America/New_York, which is where the demo business lives.
 */
import {
  getBusiness, getKnowledgeBase, getBooking, createCall, findActiveCall,
  updateCall, createBooking as dbCreateBooking, BookingRejectedError, listBookings,
} from '@/lib/db';
import { slotsForDate, nextAvailable } from '@/lib/scheduler';
import { clampDuration, DEFAULT_DURATION_MIN } from '@/lib/availability';
import {
  addDaysToDateKey, isDateKey, localDateKey, parseScheduledAt, partsInTz, spokenTimeInTz, tzOf,
} from '@/lib/time';
import { dollarsToCents, formatCents } from '@/lib/money';
import { logger } from '@/lib/log';
import { normalizePhone } from '@/lib/providers/twilio';
import { sendAndLog } from '@/lib/messaging';
import { CALL_911_EN, CALL_911_ES } from '@/lib/voice/emergency';

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

/** The telephony SID or ElevenLabs conversation id that identifies this live call. */
function callKey(args: { call_sid?: string; conversation_id?: string }): string {
  return str(args.call_sid) || str(args.conversation_id);
}

/** Match by id, then SID / conversation id only. Never guesses by caller phone or "the latest call". */
async function activeCall(
  businessId: string,
  args: { call_id?: string; call_sid?: string; conversation_id?: string; caller_phone?: string },
): Promise<Call | null> {
  return findActiveCall(businessId, {
    callId: str(args.call_id) || undefined,
    callSid: callKey(args) || undefined,
  });
}

export interface OwnerAlert {
  /** True ONLY if the SMS really went out (or demo mode mock). Never claim the owner was told otherwise. */
  notified: boolean;
  reason: 'sent' | 'no_owner_phone' | 'sms_failed' | 'sms_error';
  sms: SmsLog | null;
}

async function alertOwner(business: Business, body: string): Promise<OwnerAlert> {
  if (!business.owner_phone) {
    log.error('owner_alert.no_owner_phone', { business: business.id });
    return { notified: false, reason: 'no_owner_phone', sms: null };
  }
  try {
    const { sms, result: sent } = await sendAndLog({
      business_id: business.id, to: business.owner_phone, body, kind: 'owner_alert',
    });
    // 'mock' means no Twilio configured: only counts as delivered in explicit demo mode.
    const delivered = sent.status === 'sent' || (sent.status === 'mock' && process.env.DEMO_MODE === 'true');
    if (!delivered) log.error('owner_alert.not_delivered', { business: business.id, status: sent.status, error: sent.error ?? null });
    return { notified: delivered, reason: delivered ? 'sent' : 'sms_failed', sms };
  } catch (err) {
    log.error('owner_alert.error', { business: business.id, err });
    return { notified: false, reason: 'sms_error', sms: null };
  }
}

/** What to tell a caller when we could NOT reach the owner. */
function ownerFallback(business: Business, lang: ToolLanguage, emergency: boolean): { message: string; data: Record<string, unknown> } {
  const phone = business.owner_phone ? normalizePhone(business.owner_phone) : null;
  const call911 = say(lang, CALL_911_EN, CALL_911_ES);
  const owner = phone
    ? say(lang, `You can also call the owner directly at ${phone}.`, `También puede llamar al dueño directamente al ${phone}.`)
    : say(lang, 'I will keep trying to reach the owner and they will call you back.', 'Voy a seguir intentando comunicarme con el dueño y él le devolverá la llamada.');
  return {
    message: emergency ? `${call911} ${owner}` : owner,
    data: { call_911_for: ['gas', 'carbon_monoxide', 'smoke', 'fire'], owner_phone: phone },
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

export async function createBooking(args: CreateBookingArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);
    const tz = tzOf(business);

    const name = str(args.customer_name);
    const phone = str(args.customer_phone);
    const service = str(args.service);
    const scheduledAt = str(args.scheduled_at);

    if (!name || !phone || !service || !scheduledAt) {
      return {
        ok: false,
        message: say(lang,
          'I just need your name, a callback number, and which service you need.',
          'Solo necesito su nombre, un número para llamarle y qué servicio necesita.'),
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

    // Call matching and the confirmation number use the PLATFORM caller id, never
    // a number the model relays. The model's number is only a fallback (when there is
    // no trusted caller id), and sendSms still enforces E.164 + allowed countries.
    const call = await activeCall(business.id, args);
    const trustedPhone = call?.caller_phone || str(args.caller_phone);
    const bookingPhone = trustedPhone || phone;

    if (call) {
      const made = (await listBookings(business.id)).filter((b) => b.call_id === call.id).length;
      if (made >= MAX_BOOKINGS_PER_CALL) {
        return {
          ok: false,
          message: say(lang,
            'I have already booked two appointments on this call — let me have the owner help with anything else.',
            'Ya agendé dos citas en esta llamada — voy a pedirle al dueño que le ayude con lo demás.'),
          data: { reason: 'booking_cap' },
        };
      }
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
        call_id: call?.id ?? null,
        customer_name: name,
        customer_phone: normalizePhone(bookingPhone),
        service: catalogName,
        scheduled_at: iso,
        duration_minutes: duration,
        address: str(args.address) || null,
        price_estimate: priceEstimate,
      });
    } catch (err) {
      if (err instanceof BookingRejectedError) return await rejectionResult(err.reason, business, lang, duration, iso);
      throw err;
    }

    if (call && !call.caller_name) await updateCall(call.id, { caller_name: name });

    // The confirmation has to come back in the language they called in.
    let sms: unknown | null = null;
    try {
      sms = await sendConfirmation(booking.id, lang);
    } catch (err) {
      log.warn('confirmation.failed', { booking: booking.id, err });
    }

    return {
      ok: true,
      message: say(lang,
        `You're all set for ${whenPhrase(iso, lang, tz)}. I'm sending your confirmation text now.`,
        `Listo, quedó agendado para ${whenPhrase(iso, lang, tz)}. Le mando el texto de confirmación ahora.`),
      data: { booking, sms_sent: sms != null },
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
    case 'past':
      return { ok: false, data, message: say(lang,
        `That time has already passed. ${alt}`, `Esa hora ya pasó. ${alt}`) };
    case 'after_close':
      return { ok: false, data, message: say(lang,
        `That job would run past our closing time. ${alt}`,
        `Ese trabajo terminaría después de nuestra hora de cierre. ${alt}`) };
    case 'closed_day':
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
    const call = await activeCall(business.id, { call_id: args.call_id, call_sid: args.call_sid, conversation_id: args.conversation_id });
    const callerPhone = call?.caller_phone || str(args.caller_phone);
    const key = (p: string) => p.replace(/\D/g, '').slice(-10);
    const wanted = str(args.to);
    const to = wanted && business.owner_phone
      && (wanted.toLowerCase() === 'owner' || key(wanted) === key(business.owner_phone))
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

    const toOwner = Boolean(business.owner_phone) && key(to) === key(business.owner_phone as string);
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

    if (sent.status === 'failed') {
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
    const call = await activeCall(business.id, args);
    // Recipient is never taken from the model: the booking's number or this call's caller id.
    const to = normalizePhone(
      booking?.customer_phone || call?.caller_phone || str(args.caller_phone) || '',
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
    let sms: unknown | null = null;
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

    const reason = str(args.reason) || 'Emergency reported on call';
    const callerName = str(args.customer_name);
    const callerPhone = str(args.customer_phone);
    const address = str(args.address);

    let call = await activeCall(business.id, { ...args, caller_phone: callerPhone });
    if (!call) {
      // No live call to attach to (e.g. a tool call from the demo simulator).
      call = await createCall({
        business_id: business.id,
        call_sid: callKey(args) || null,
        caller_phone: callerPhone ? normalizePhone(callerPhone) : null,
        caller_name: callerName || null,
        status: 'in_progress',
      });
    }

    const updated = await updateCall(call.id, {
      urgency: 'emergency',
      flagged_reason: reason,
      ...(callerName && !call.caller_name ? { caller_name: callerName } : {}),
      ...(callerPhone && !call.caller_phone ? { caller_phone: normalizePhone(callerPhone) } : {}),
    });

    const alertBody = [
      `EMERGENCY — ${business.name}`,
      callerName ? `Caller: ${callerName}` : '',
      callerPhone ? `Phone: ${normalizePhone(callerPhone)}` : call.caller_phone ? `Phone: ${call.caller_phone}` : '',
      address ? `Address: ${address}` : '',
      `Reason: ${reason}`,
      'Call them back now.',
    ].filter(Boolean).join('\n');
    const alert = await alertOwner(business, alertBody);

    if (alert.notified) {
      return {
        ok: true,
        message: say(lang,
          `${CALL_911_EN} I've flagged this as an emergency and the owner has been notified.`,
          `${CALL_911_ES} Lo marqué como emergencia y el dueño ya fue notificado.`),
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

/** Spanish callers describe the same jobs with different words — bridge them. */
const SERVICE_ALIASES: Record<string, string> = {
  reparacion: 'repair', reparación: 'repair', arreglar: 'repair', arreglo: 'repair',
  instalacion: 'installation', instalación: 'installation', instalar: 'installation',
  mantenimiento: 'maintenance', afinacion: 'maintenance', afinación: 'maintenance',
  servicio: 'service', diagnostico: 'diagnostic', diagnóstico: 'diagnostic',
  revision: 'diagnostic', revisión: 'diagnostic', visita: 'visit',
  limpieza: 'cleaning', ductos: 'duct', conductos: 'duct',
  emergencia: 'emergency', emergencias: 'emergency', urgencia: 'emergency',
  aire: 'ac', acondicionado: 'ac', equipo: 'system', sistema: 'system',
  calefaccion: 'heating', calefacción: 'heating', calentar: 'heating',
};

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SERVICE_ALIASES[w] ?? w)
    .join(' ');
}

function matchService<T extends { name: string }>(services: T[], query: string): T[] {
  const q = normalizeQuery(query).trim();
  if (!q) return services;
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const scored = services
    .map((s) => {
      const name = s.name.toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.includes(q)) score = 80;
      else if (q.includes(name)) score = 70;
      else score = words.filter((w) => name.includes(w)).length * 20;
      return { s, score };
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
  /** True when the caller objected to the AI / recording: mark consent declined and take a message. */
  consent_declined?: boolean | string;
}

export async function handoffToHuman(args: HandoffArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = await resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const reason = str(args.reason) || 'Caller asked for a human';
    let call = await activeCall(business.id, args);
    if (!call) {
      call = await createCall({ business_id: business.id, call_sid: callKey(args) || null, status: 'in_progress' });
    }

    const declined = args.consent_declined === true || String(args.consent_declined).toLowerCase() === 'true';
    const updated = await updateCall(call.id, {
      status: 'handed_off',
      flagged_reason: reason,
      // Post-call processing stores no transcript/summary for declined calls.
      ...(declined ? { consent_status: 'declined' as const } : {}),
    });

    const alertBody = [
      `HANDOFF — ${business.name}`,
      call.caller_name ? `Caller: ${call.caller_name}` : '',
      call.caller_phone ? `Phone: ${call.caller_phone}` : '',
      `Reason: ${reason}`,
      'Please call them back.',
    ].filter(Boolean).join('\n');
    const alert = await alertOwner(business, alertBody);

    if (alert.notified) {
      // This does NOT transfer the line: the owner was texted and will call back.
      return {
        ok: true,
        message: declined ? say(lang,
          "Understood — we won't keep a transcript of this call. I've sent the owner a message and they will call you back. What's the best number to reach you?",
          'Entendido — no guardaremos una transcripción de esta llamada. Le envié un mensaje al dueño y le devolverá la llamada. ¿Cuál es el mejor número para localizarle?')
        : say(lang,
          "I've sent the owner an urgent message and they will call you back shortly. Is this the best number to reach you?",
          'Le envié un mensaje urgente al dueño y le devolverá la llamada pronto. ¿Es este el mejor número para localizarle?'),
        data: { call: updated, owner_sms: alert.sms, owner_notified: true, transferred: false },
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

export const TOOL_NAMES = [
  'check_availability',
  'create_booking',
  'send_sms',
  'create_payment_link',
  'flag_emergency',
  'get_pricing',
  'handoff_to_human',
] as const;

export type ToolName = typeof TOOL_NAMES[number];

/** ElevenLabs may send "Check Availability", "checkAvailability", etc. */
function canonicalTool(raw: string): ToolName | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const direct = TOOL_NAMES.find((t) => t === key);
  if (direct) return direct;
  const compact = key.replace(/_/g, '');
  return TOOL_NAMES.find((t) => t.replace(/_/g, '') === compact) ?? null;
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
      switch (tool) {
        case 'check_availability': return await checkAvailability(a);
        case 'create_booking': return await createBooking(a);
        case 'send_sms': return await sendSmsTool(a);
        case 'create_payment_link': return await createPaymentLink(a);
        case 'flag_emergency': return await flagEmergency(a);
        case 'get_pricing': return await getPricing(a);
        case 'handoff_to_human': return await handoffToHuman(a);
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

