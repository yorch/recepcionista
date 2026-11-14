/**
 * WS3 — the seven voice-agent tools. Every tool returns a spoken-ready
 * `message` in the caller's language and NEVER throws: a failed tool must
 * still leave the agent with something to say.
 *
 * Locale: English and Spanish for every path. Times are always rendered in
 * America/New_York, which is where the demo business lives.
 */
import {
  getBusiness, getKnowledgeBase, getCall, listCalls, listBookings, createCall,
  updateCall, createBooking as dbCreateBooking, getBookedSlots, logSms,
} from '@/lib/db';
import { slotsForDate, nextAvailable, isWithinHours } from '@/lib/scheduler';
import { sendSms, normalizePhone } from '@/lib/providers/twilio';
import { createPaymentLink as providerCreatePaymentLink, appUrl } from '@/lib/providers/stripe';
import type { Business, Call, SmsLog, TimeSlot } from '@/lib/types';

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
  language?: string;
}

const TZ = 'America/New_York';
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
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

interface EtParts { dateKey: string; weekday: string; hour: number; minute: number }

function etParts(iso: string): EtParts {
  const out: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
  });
  for (const part of fmt.formatToParts(new Date(iso))) out[part.type] = part.value;
  return {
    dateKey: `${out.year}-${out.month}-${out.day}`,
    weekday: out.weekday ?? '',
    hour: Number(out.hour ?? 0),
    minute: Number(out.minute ?? 0),
  };
}

function spokenTime(iso: string): string {
  const { hour, minute } = etParts(iso);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
}

function dayPhrase(iso: string, lang: ToolLanguage): string {
  const key = etParts(iso).dateKey;
  const todayKey = etParts(new Date().toISOString()).dateKey;
  const tomorrowKey = etParts(new Date(Date.now() + 86_400_000).toISOString()).dateKey;
  if (key === todayKey) return lang === 'es' ? 'hoy' : 'today';
  if (key === tomorrowKey) return lang === 'es' ? 'mañana' : 'tomorrow';
  const idx = WEEKDAY_EN.findIndex((d) => d.toLowerCase() === etParts(iso).weekday.toLowerCase());
  if (idx < 0) return etParts(iso).dateKey;
  return lang === 'es' ? WEEKDAY_ES[idx] : WEEKDAY_EN[idx];
}

function whenPhrase(iso: string, lang: ToolLanguage): string {
  const day = dayPhrase(iso, lang);
  const time = spokenTime(iso);
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
function describeSlots(slots: TimeSlot[], lang: ToolLanguage): string {
  const groups: { day: string; times: string[] }[] = [];
  for (const slot of slots) {
    const day = dayPhrase(slot.start, lang);
    const time = spokenTime(slot.start);
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

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
}

function parseHhmm(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Strict open-hours check in the business's own timezone. */
function insideOpenHours(business: Business, iso: string): boolean {
  const { weekday, hour, minute } = etParts(iso);
  const idx = WEEKDAY_EN.findIndex((d) => d.toLowerCase() === weekday.toLowerCase());
  if (idx < 0) return false;
  const hours = business.hours?.[DAY_KEYS[idx]];
  if (!hours) return false;
  const minutes = hour * 60 + minute;
  return minutes >= parseHhmm(hours.open) && minutes <= parseHhmm(hours.close);
}

function minutesOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 60_000);
}

/** A short "I could do X instead" clause built from the real calendar. */
function alternativeClause(business: Business, lang: ToolLanguage): string {
  const slot = nextAvailable(business, 1)[0];
  if (!slot) {
    return say(lang,
      'Nothing is open in the next two weeks.',
      'No hay nada disponible en las próximas dos semanas.');
  }
  return say(lang,
    `I can do ${whenPhrase(slot.start, lang)} instead.`,
    `Puedo ${whenPhrase(slot.start, lang)}.`);
}

// ------------------------------------------------------------- infrastructure

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function resolveBusiness(args: BaseArgs): Business | null {
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

function activeCall(businessId: string, callId?: string): Call | null {
  const explicit = str(callId);
  if (explicit) {
    const call = getCall(explicit);
    if (call) return call;
  }
  // Most recent in-progress call for this business.
  return listCalls(businessId).find((c) => c.status === 'in_progress') ?? null;
}

async function postInternal(path: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(`${appUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // WS4 owns these routes; the voice call must survive their absence.
    return null;
  }
}

async function alertOwner(business: Business, body: string): Promise<SmsLog | null> {
  if (!business.owner_phone) return null;
  const to = normalizePhone(business.owner_phone);
  const sent = await sendSms(to, body);
  return logSms({
    business_id: business.id,
    to_phone: to,
    body,
    kind: 'owner_alert',
    provider_id: sent.id || null,
    status: sent.status,
  });
}

// ------------------------------------------------------------------- tools

export interface CheckAvailabilityArgs extends BaseArgs {
  date?: string;
  duration_minutes?: number | string;
}

export async function checkAvailability(args: CheckAvailabilityArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const duration = Number(args.duration_minutes) || 60;
    const requested = str(args.date);
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(requested)
      ? requested
      : requested
        ? new Date(requested).toISOString().slice(0, 10)
        : '';

    let slots: TimeSlot[];
    let dayFull = false;
    if (dateStr) {
      slots = slotsForDate(business, dateStr, duration).filter((s) => s.available).slice(0, 3);
      if (slots.length === 0) {
        dayFull = true;
        slots = nextAvailable(business, 3, duration);
      }
    } else {
      slots = nextAvailable(business, 3, duration);
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

    const list = describeSlots(slots, lang);
    const multiple = slots.length > 1;
    const prefix = dayFull
      ? say(lang, `That day is full, but I have ${list}`, `Ese día está lleno, pero tengo ${list}`)
      : say(lang, `I have ${list}`, `Tengo ${list}`);
    const message = multiple
      ? say(lang, `${prefix} — which works better?`, `${prefix} — ¿cuál le queda mejor?`)
      : say(lang, `${prefix} open — does that work for you?`, `${prefix} disponible — ¿le queda bien?`);

    return { ok: true, message, data: { slots } };
  } catch {
    return {
      ok: false,
      message: say(lang,
        'Let me check the calendar with the owner and call you right back.',
        'Déjeme revisar el calendario con el dueño y le llamo ahora.'),
    };
  }
}

export interface CreateBookingArgs extends BaseArgs {
  customer_name?: string;
  customer_phone?: string;
  service?: string;
  scheduled_at?: string;
  address?: string;
  price_estimate?: number | string;
}

export async function createBooking(args: CreateBookingArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = resolveBusiness(args);
    if (!business) return missingBusiness(lang);

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

    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      return {
        ok: false,
        message: say(lang,
          'I did not catch that day and time — can you say it again?',
          'No le entendí la fecha y la hora — ¿me la repite?'),
      };
    }
    const iso = when.toISOString();
    const dateKey = etParts(iso).dateKey;

    if (!insideOpenHours(business, iso)) {
      return {
        ok: false,
        message: say(lang,
          `That is outside our hours. ${alternativeClause(business, lang)}`,
          `Eso está fuera de nuestro horario. ${alternativeClause(business, lang)}`),
        data: { reason: 'outside_hours', scheduled_at: iso },
      };
    }

    const bookedMinutes = new Set<number>([
      ...getBookedSlots(business.id, dateKey).map(minutesOf),
      ...listBookings(business.id)
        .filter((b) => etParts(b.scheduled_at).dateKey === dateKey)
        .map((b) => minutesOf(b.scheduled_at)),
    ]);
    if (bookedMinutes.has(minutesOf(iso))) {
      return {
        ok: false,
        message: say(lang,
          `That slot just got taken. ${alternativeClause(business, lang)}`,
          `Ese horario se acaba de ocupar. ${alternativeClause(business, lang)}`),
        data: { reason: 'slot_taken', scheduled_at: iso },
      };
    }

    if (!isWithinHours(business, iso)) {
      return {
        ok: false,
        message: say(lang,
          `I cannot fit that one in. ${alternativeClause(business, lang)}`,
          `No puedo acomodar esa hora. ${alternativeClause(business, lang)}`),
        data: { reason: 'not_within_hours', scheduled_at: iso },
      };
    }

    const call = activeCall(business.id, args.call_id);
    const priceEstimate = args.price_estimate == null || str(args.price_estimate) === ''
      ? null
      : Number(args.price_estimate);

    const booking = dbCreateBooking({
      business_id: business.id,
      call_id: call?.id ?? null,
      customer_name: name,
      customer_phone: normalizePhone(phone),
      service,
      scheduled_at: iso,
      address: str(args.address) || null,
      price_estimate: priceEstimate != null && Number.isFinite(priceEstimate) ? priceEstimate : null,
    });

    if (call && !call.caller_name) updateCall(call.id, { caller_name: name });

    // The confirmation has to come back in the language they called in.
    const sms = await postInternal('/api/sms/confirmation', {
      booking_id: booking.id,
      language: lang,
    });

    return {
      ok: true,
      message: say(lang,
        `You're all set for ${whenPhrase(iso, lang)}. I'm sending your confirmation text now.`,
        `Listo, quedó agendado para ${whenPhrase(iso, lang)}. Le mando el texto de confirmación ahora.`),
      data: { booking, sms_sent: sms != null },
    };
  } catch {
    return {
      ok: false,
      message: say(lang,
        'I had trouble putting that in the calendar — let me have the owner confirm it with you.',
        'Tuve un problema agendando eso — voy a pedirle al dueño que se lo confirme.'),
    };
  }
}

export interface SendSmsArgs extends BaseArgs {
  to?: string;
  body?: string;
}

export async function sendSmsTool(args: SendSmsArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const to = str(args.to);
    const body = str(args.body);
    if (!to || !body) {
      return {
        ok: false,
        message: say(lang,
          'I need a phone number and a message before I can send that text.',
          'Necesito un número y el mensaje antes de poder mandar el texto.'),
      };
    }

    const e164 = normalizePhone(to);
    const sent = await sendSms(e164, body);
    const log = logSms({
      business_id: business.id,
      to_phone: e164,
      body,
      kind: 'other',
      provider_id: sent.id || null,
      status: sent.status,
    });

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
  } catch {
    return {
      ok: false,
      message: say(lang,
        'I could not send that text — let me read it to you instead.',
        'No pude mandar el texto — mejor se lo leo por teléfono.'),
    };
  }
}

const DEPOSIT_CAP_CENTS = 50_000;

export interface CreatePaymentLinkArgs extends BaseArgs {
  amount_cents?: number | string;
  description?: string;
  booking_id?: string;
  to?: string;
}

export async function createPaymentLink(args: CreatePaymentLinkArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = resolveBusiness(args);
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
    const capped = requested > DEPOSIT_CAP_CENTS;
    const amountCents = capped ? DEPOSIT_CAP_CENTS : requested;
    const description = str(args.description) || 'Service deposit';

    const bookingId = str(args.booking_id);
    const booking = bookingId
      ? listBookings(business.id).find((b) => b.id === bookingId) ?? null
      : null;
    const call = activeCall(business.id, args.call_id);
    const to = normalizePhone(
      str(args.to) || booking?.customer_phone || call?.caller_phone || '',
    );

    const link = await providerCreatePaymentLink(amountCents, description, business.name);

    // Best-effort: WS4 owns /api/sms/payment-link.
    const sms = to
      ? await postInternal('/api/sms/payment-link', {
        business_id: business.id,
        booking_id: booking?.id ?? (bookingId || undefined),
        to,
        amount_cents: amountCents,
        description,
        url: link.url,
        link_id: link.id,
        language: lang,
      })
      : null;

    const spoken = money(amountCents);
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
  } catch {
    return {
      ok: false,
      message: say(lang,
        'I could not create that payment link — let me have the owner call you to take the deposit.',
        'No pude crear el enlace de pago — voy a pedirle al dueño que le llame para el depósito.'),
    };
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
    const business = resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const reason = str(args.reason) || 'Emergency reported on call';
    const callerName = str(args.customer_name);
    const callerPhone = str(args.customer_phone);
    const address = str(args.address);

    let call = activeCall(business.id, args.call_id);
    if (!call) {
      // No live call to attach to (e.g. a tool call from the demo simulator).
      call = createCall({
        business_id: business.id,
        caller_phone: callerPhone ? normalizePhone(callerPhone) : null,
        caller_name: callerName || null,
        status: 'in_progress',
      });
    }

    const updated = updateCall(call.id, {
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

    return {
      ok: true,
      message: say(lang,
        "I've flagged this as an emergency and the owner has been notified.",
        'Lo marqué como emergencia y el dueño ya fue notificado.'),
      data: { call: updated, owner_sms: alert, owner_notified: alert != null },
    };
  } catch {
    return {
      ok: false,
      message: say(lang,
        'I have your details and I am getting the owner now — stay on the line.',
        'Ya tengo sus datos y estoy consiguiendo al dueño — no cuelgue.'),
    };
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
    const business = resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const kb = getKnowledgeBase(business.id);
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
        `${match.name} starts at ${money(priced * 100)}. The technician confirms the exact price on site.`,
        `${match.name} empieza en ${money(priced * 100)}. El técnico confirma el precio exacto en el lugar.`),
      data: {
        matched: true,
        price: priced,
        service: match.name,
        description: match.description ?? null,
        pricing_notes: kb?.pricing_notes ?? null,
      },
    };
  } catch {
    return {
      ok: true,
      message: say(lang,
        "I'll have the owner confirm that price for you.",
        'Voy a pedirle al dueño que le confirme ese precio.'),
      data: { matched: false, price: null },
    };
  }
}

export interface HandoffArgs extends BaseArgs {
  reason?: string;
}

export async function handoffToHuman(args: HandoffArgs): Promise<ToolResult> {
  const lang = langOf(args.language);
  try {
    const business = resolveBusiness(args);
    if (!business) return missingBusiness(lang);

    const reason = str(args.reason) || 'Caller asked for a human';
    let call = activeCall(business.id, args.call_id);
    if (!call) {
      call = createCall({ business_id: business.id, status: 'in_progress' });
    }

    const updated = updateCall(call.id, {
      status: 'handed_off',
      flagged_reason: reason,
    });

    const alertBody = [
      `HANDOFF — ${business.name}`,
      call.caller_name ? `Caller: ${call.caller_name}` : '',
      call.caller_phone ? `Phone: ${call.caller_phone}` : '',
      `Reason: ${reason}`,
      'They are waiting for you.',
    ].filter(Boolean).join('\n');
    const alert = await alertOwner(business, alertBody);

    return {
      ok: true,
      message: say(lang,
        'Let me connect you with the owner — one moment.',
        'Permítame comunicarle con el dueño — un momento.'),
      data: { call: updated, owner_sms: alert, owner_notified: alert != null },
    };
  } catch {
    return {
      ok: false,
      message: say(lang,
        'I am getting the owner for you now — please hold.',
        'Estoy consiguiendo al dueño — por favor espere.'),
    };
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
  if (!tool) {
    return {
      ok: false,
      message: say(lang, 'Let me get the owner for that.', 'Permítame conseguir al dueño para eso.'),
    };
  }
  const a = (args ?? {}) as Record<string, never>;
  try {
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
  } catch {
    return {
      ok: false,
      message: say(lang,
        'Let me get the owner for that.',
        'Permítame conseguir al dueño para eso.'),
    };
  }
}

