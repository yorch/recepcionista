/**
 * The end-of-day voice note. The whole point is that it sounds like a person
 * telling you about your day, not a report — so the deterministic fallback is
 * written with as much care as the LLM path.
 */
import { generateTextSafe } from '@/lib/providers/llm';
import {
  createBriefing, getBusiness, listBookings, listCalls,
} from '@/lib/db';
import type { Booking, Briefing, Business, Call } from '@/lib/types';
import { synthesizeBriefing } from './tts';

const TZ = 'America/New_York';
const MIN_WORDS = 90;
const MAX_WORDS = 160;

function dayKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
  }).format(new Date(iso));
}

function spanishClock(iso: string): string {
  return new Intl.DateTimeFormat('es-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
  }).format(new Date(iso));
}

function weekday(iso: string): string {
  return new Intl.DateTimeFormat('es-US', { weekday: 'long', timeZone: TZ }).format(new Date(iso));
}

function money(n?: number | null): string {
  if (n == null) return 'el precio acordado';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function nameOf(booking: Booking): string {
  return booking.customer_name.split(' ')[0];
}


function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function gather(businessId: string, date: string) {
  const calls = await listCalls(businessId, date);
  const allBookings = await listBookings(businessId);
  const bookings = allBookings.filter(
    (b) => b.scheduled_at.startsWith(date) || b.created_at.startsWith(date),
  );
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
  const owner = business.owner_name || 'Jorge';
  const { calls, bookings, flagged, deposits } = data;
  const parts: string[] = [`Hola ${owner}.`];

  if (calls.length === 0 && bookings.length === 0) {
    return `Hola ${owner}. Hoy estuvo tranquilo de verdad — cero llamadas y el calendario vacío. Aproveché para dejar todo listo para mañana, así que arrancamos temprano y sin pendientes. Si quieres, mañana te mando el resumen otra vez a la misma hora. Descansa. Eso es todo.`;
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
      `Se cerró una cita: ${nameOf(b)}, ${b.service.toLowerCase()}, el ${weekday(b.scheduled_at)} a las ${spanishClock(b.scheduled_at)}, por ${money(b.price_estimate)}.`,
    );
  } else {
    const list = upcoming
      .slice(0, 3)
      .map((b) => `${nameOf(b)} el ${weekday(b.scheduled_at)} a las ${spanishClock(b.scheduled_at)} para ${b.service.toLowerCase()}`)
      .join('; ');
    parts.push(`Se cerraron ${upcoming.length} citas: ${list}.`);
  }

  if (deposits > 0) {
    parts.push(`Ya entraron $${deposits.toLocaleString('en-US')} en depósitos, así que ese dinero está seguro.`);
  } else if (data.stats.revenue > 0) {
    parts.push(`El día cerró alrededor de $${data.stats.revenue.toLocaleString('en-US')} en trabajo.`);
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

  const facts = {
    owner: business.owner_name ?? 'Jorge',
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
      at: `${weekday(b.scheduled_at)} ${clock(b.scheduled_at)}`,
      price: b.price_estimate,
      deposit_paid: b.deposit_paid,
      deposit: b.deposit_amount,
      status: b.status,
    })),
    deposits_collected: data.deposits,
    total_revenue: data.stats.revenue,
  };

  const { value } = await generateTextSafe(
    [
      {
        role: 'system',
        content:
          'You write a 45-second voice note from an AI receptionist to the owner of a Miami HVAC company. ' +
          'Write in natural SPANGLISH — Spanish sentence structure with English trade words (AC, compressor, booked, deposit, tech). ' +
          'Warm, spoken, first person. 110-140 words. No bullet points, no headers, no markdown. ' +
          'Open with "Hola {owner}." Name the real bookings with real times. Say the money collected. ' +
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
    console.warn(`[briefing] LLM script was ${words} words, using deterministic fallback`);
    return fallback;
  }
  return value.trim();
}

export async function generateBriefing(businessId: string, date?: string): Promise<Briefing> {
  const business = await getBusiness(businessId);
  if (!business) throw new Error('business not found');

  const day = date ?? dayKey();
  const data = await gather(businessId, day);
  const transcript = await narrate(business, data, day);
  const audio = await synthesizeBriefing(transcript, { businessId, date: day });

  return await createBriefing({
    business_id: businessId,
    date: day,
    transcript,
    audio_url: audio.audio_url,
    stats: data.stats,
  });
}

export { fallbackScript, gather, wordCount };
