/**
 * The end-of-day voice note. The whole point is that it sounds like a person
 * telling you about your day, not a report — so the deterministic fallback is
 * written with as much care as the LLM path.
 */
import { generateTextSafe } from '@/lib/providers/llm';
import {
  createBriefing, getBusiness, listBookingsForDay, listCalls,
} from '@/lib/db';
import { isDateKey, localDateKey, tzOf } from '@/lib/time';
import { formatCents } from '@/lib/money';
import type { Booking, Briefing, Business, Call } from '@/lib/types';
import { synthesizeBriefing } from './tts';
import { logger } from '@/lib/log';

const log = logger('briefing');

const MIN_WORDS = 90;
const MAX_WORDS = 160;

// All clock/day rendering is in the BUSINESS zone, never the process zone.
function clock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(new Date(iso));
}

function spanishClock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('es-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(new Date(iso));
}

function weekday(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('es-US', { weekday: 'long', timeZone: tz }).format(new Date(iso));
}

/** Cents in, spoken-ready dollars out. */
function money(cents?: number | null): string {
  if (cents == null) return 'el precio acordado';
  return formatCents(cents);
}

function nameOf(booking: Booking): string {
  return booking.customer_name.split(' ')[0];
}


function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function gather(businessId: string, date: string, tz?: string) {
  // One consistent local-day range (business zone) for both calls and bookings, in SQL.
  const calls = await listCalls(businessId, date, tz);
  // Cancelled bookings are excluded from stats and narration alike.
  const bookings = (await listBookingsForDay(businessId, date, tz)).filter((b) => b.status !== 'cancelled');
  const flagged = calls.filter((c) => c.flagged_reason);

  const revenue = bookings.reduce((sum, b) => {
    if (b.deposit_paid && b.deposit_amount) return sum + b.deposit_amount;
    if (b.status === 'completed' && b.price_estimate) return sum + b.price_estimate;
    return sum;
  }, 0);

  const deposits = bookings
    .filter((b) => b.deposit_paid)
    .reduce((sum, b) => sum + (b.deposit_amount ?? 0), 0);

  return {
    calls,
    bookings,
    flagged,
    stats: {
      calls: calls.length,
      bookings: bookings.length,
      revenue,
      flags: flagged.length,
    },
    deposits,
  };
}

/**
 * Deterministic Spanglish narration. Uses the real names, times and dollars, and
 * varies its shape with the data so a quiet day never sounds like a busy one.
 * Length is tuned to land near 45 seconds spoken (~120 words).
 */
function fallbackScript(
  business: Business,
  data: Awaited<ReturnType<typeof gather>>,
): string {
  const owner = business.owner_name?.trim() || '';
  const hola = owner ? `Hola ${owner}.` : 'Hola.';
  const tz = tzOf(business);
  const { calls, bookings, flagged, deposits } = data;
  const parts: string[] = [hola];

  if (calls.length === 0 && bookings.length === 0) {
    return `${hola} Hoy estuvo tranquilo de verdad — cero llamadas y el calendario vacío. Aproveché para dejar todo listo para mañana, así que arrancamos temprano y sin pendientes. Si quieres, mañana te mando el resumen otra vez a la misma hora. Descansa. Eso es todo.`;
  }

  if (calls.length === 0) {
    parts.push('Hoy no entraron llamadas, pero tienes trabajo en el calendario.');
  } else if (calls.length === 1) {
    parts.push('Hoy entró una llamada y la manejé completa.');
  } else {
    const bilingual = calls.filter((c) => c.language === 'es' || c.language === 'mixed').length;
    let langNote = '';
    if (bilingual === calls.length) langNote = ', todas en español o en los dos idiomas';
    else if (bilingual > 0) langNote = `, ${bilingual} de ellas en español o en los dos`;
    parts.push(`Hoy entraron ${calls.length} llamadas${langNote}.`);
  }

  const upcoming = bookings
    .filter((b) => b.status !== 'cancelled')
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));

  if (upcoming.length === 0) {
    parts.push('No se cerró ninguna cita, así que todavía hay espacio para meter trabajo mañana.');
  } else if (upcoming.length === 1) {
    const b = upcoming[0];
    parts.push(
      `Se cerró una cita: ${nameOf(b)}, ${b.service.toLowerCase()}, el ${weekday(b.scheduled_at, tz)} a las ${spanishClock(b.scheduled_at, tz)}, por ${money(b.price_estimate)}.`,
    );
  } else {
    const list = upcoming
      .slice(0, 3)
      .map((b) => `${nameOf(b)} el ${weekday(b.scheduled_at, tz)} a las ${spanishClock(b.scheduled_at, tz)} para ${b.service.toLowerCase()}`)
      .join('; ');
    parts.push(`Se cerraron ${upcoming.length} citas: ${list}.`);
  }

  if (deposits > 0) {
    parts.push(`Ya entraron ${formatCents(deposits)} en depósitos, así que ese dinero está seguro.`);
  } else if (data.stats.revenue > 0) {
    parts.push(`El día cerró alrededor de ${formatCents(data.stats.revenue)} en trabajo.`);
  }

  const handled = calls.filter((c) => c.summary).length;
  if (handled > 0 && calls.length > 1) {
    parts.push('A todas les tomé los datos, el problema y la dirección, así que no tienes que devolver llamadas para averiguar nada.');
  }

  const emergencies = calls.filter((c) => c.urgency === 'emergency').length;
  if (emergencies > 0) {
    parts.push(`Manejé ${emergencies === 1 ? 'una emergencia' : emergencies + ' emergencias'} hoy — el cliente quedó tranquilo y el tech está enterado.`);
  }

  if (flagged.length === 0) {
    parts.push('Nada urgente pendiente, todo va bien.');
  } else {
    const first = flagged[0];
    const who = first.caller_name ? first.caller_name.split(' ')[0] : 'un cliente';
    const reason = (first.flagged_reason ?? '').replace(/^[^:]*:\s*/, '').toLowerCase();
    if (flagged.length === 1) {
      parts.push(`Una sola cosa necesita tu atención: ${who}, ${reason}. Te dejé el número en el dashboard para que le caigas cuando puedas.`);
    } else {
      parts.push(`${flagged.length} cosas necesitan tu atención. La primera es ${who}, ${reason}. Los números están todos en el dashboard.`);
    }
  }

  parts.push('Eso es todo. Buen trabajo hoy.');
  return parts.join(' ');
}

async function narrate(
  business: Business,
  data: Awaited<ReturnType<typeof gather>>,
  date: string,
): Promise<string> {
  const fallback = fallbackScript(business, data);
  const tz = tzOf(business);

  const facts = {
    owner: business.owner_name?.trim() || null,
    business: business.name,
    date,
    calls: data.calls.map((c: Call) => ({
      caller: c.caller_name ?? c.caller_phone,
      language: c.language,
      urgency: c.urgency,
      summary: c.summary,
      flagged: c.flagged_reason,
    })),
    bookings: data.bookings.map((b: Booking) => ({
      customer: b.customer_name,
      service: b.service,
      at: `${weekday(b.scheduled_at, tz)} ${clock(b.scheduled_at, tz)}`,
      price_usd: b.price_estimate == null ? null : b.price_estimate / 100,
      deposit_paid: b.deposit_paid,
      deposit_usd: b.deposit_amount == null ? null : b.deposit_amount / 100,
      status: b.status,
    })),
    deposits_collected_usd: data.deposits / 100,
    total_revenue_usd: data.stats.revenue / 100,
  };

  const { value } = await generateTextSafe(
    [
      {
        role: 'system',
        content:
          `You write a 45-second voice note from an AI receptionist to the owner of a small local service business called "${business.name}". ` +
          'Write in natural SPANGLISH — Spanish sentence structure with the English trade words this business would use (booked, deposit, tech, the service names). ' +
          'Warm, spoken, first person. 110-140 words. No bullet points, no headers, no markdown. ' +
          'Open with "Hola" and the owner\'s name from the data (just "Hola." when the owner is null). Name the real bookings with real times. Say the money collected. ' +
          'End with the ONE thing needing attention, or say nothing is pending. Close with "Eso es todo."',
      },
      {
        role: 'user',
        content: `Here is the day's data as JSON:\n${JSON.stringify(facts, null, 2)}\n\nWrite only the spoken script.`,
      },
    ],
    fallback,
    0.6,
  );

  const words = wordCount(value);
  // Guard the length contract; a runaway model would blow past the 45 seconds.
  if (words < MIN_WORDS || words > MAX_WORDS) {
    log.warn('narrate.words_out_of_range', { words, min: MIN_WORDS, max: MAX_WORDS, used_fallback: true });
    return fallback;
  }
  log.debug('narrate.ok', { words });
  return value.trim();
}

export async function generateBriefing(businessId: string, date?: string): Promise<Briefing> {
  const started = Date.now();
  const business = await getBusiness(businessId);
  if (!business) {
    log.warn('generate.business_not_found', { business: businessId });
    throw new Error('business not found');
  }

  const tz = tzOf(business);
  const day = date ?? localDateKey(new Date(), tz);
  // The date becomes a DB key and part of an audio file path: accept only a real calendar date.
  if (!isDateKey(day)) throw new Error('invalid date: expected YYYY-MM-DD');
  const data = await gather(businessId, day, tz);
  log.info('generate.start', {
    business: businessId,
    date: day,
    calls: data.calls.length,
    bookings: data.bookings.length,
    flags: data.stats.flags,
    revenue: data.stats.revenue,
  });

  const transcript = await narrate(business, data, day);
  const audio = await synthesizeBriefing(transcript, { businessId, date: day });

  const briefing = await createBriefing({
    business_id: businessId,
    date: day,
    transcript,
    audio_url: audio.audio_url,
    stats: data.stats,
  });
  log.info('generate.done', {
    business: businessId,
    date: day,
    words: wordCount(transcript),
    audio: audio.audio_url ?? null,
    ms: Date.now() - started,
  });
  return briefing;
}

export { fallbackScript, gather, wordCount };
