/**
 * The end-of-day voice note. The whole point is that it sounds like a person
 * telling you about your day, not a report — so the deterministic fallback is
 * written with as much care as the LLM path.
 */
import { generateTextSafe } from '@/lib/providers/llm';
import {
  createBriefing, deleteBriefingAudio, getBusiness, listBookingsForDay, listCalls, saveBriefingAudio,
} from '@/lib/db';
import { isDateKey, localDateKey, tzOf } from '@/lib/time';
import { formatCents } from '@/lib/money';
import type { Booking, Briefing, Business, Call } from '@/lib/types';
import { synthesizeBriefing, type TtsFailure } from './tts';
import { logger } from '@/lib/log';
import { packOf } from '@/lib/verticals';
import { ownerLocaleFor } from '@/lib/i18n/owner-locale';
import type { Locale } from '@/lib/i18n/core';

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
 * The AUTOMATIC summary: what is used when no AI writer is available (no LLM key, a provider failure, or a model reply of the wrong length).
 * It states ONLY facts derived from the day's data (counts, names, times, dollars, the calls flagged for attention) and says up front that it is
 * an automatic summary. It never claims an action nobody performed ("everything is ready", "the customer is calm", "I took every detail").
 * Shown as "Automatic summary" in the dashboard and stored with `stats.narration = 'automatic'`.
 */
function fallbackScript(
  business: Business,
  data: Awaited<ReturnType<typeof gather>>,
  locale: Locale = 'es',
): string {
  if (locale === 'en') return fallbackScriptEn(business, data);
  const owner = business.owner_name?.trim() || '';
  const hola = owner ? `Hola ${owner}.` : 'Hola.';
  const tz = tzOf(business);
  const { calls, bookings, flagged, deposits } = data;
  const parts: string[] = [hola, 'Este es el resumen automático del día, armado solo con los datos de las llamadas y el calendario.'];

  if (calls.length === 0 && bookings.length === 0) {
    parts.push('Hoy no hubo llamadas ni citas.', 'Eso es todo.');
    return parts.join(' ');
  }

  if (calls.length === 0) {
    parts.push('Hoy no hubo llamadas.');
  } else if (calls.length === 1) {
    parts.push('Hoy hubo una llamada.');
  } else {
    const bilingual = calls.filter((c) => c.language === 'es' || c.language === 'mixed').length;
    let langNote = '';
    if (bilingual === calls.length) langNote = ', todas en español o en los dos idiomas';
    else if (bilingual > 0) langNote = `, ${bilingual} de ellas en español o en los dos`;
    parts.push(`Hoy hubo ${calls.length} llamadas${langNote}.`);
  }

  const upcoming = bookings
    .filter((b) => b.status !== 'cancelled')
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));

  if (upcoming.length === 0) {
    parts.push('No hay citas registradas para hoy.');
  } else if (upcoming.length === 1) {
    const b = upcoming[0];
    parts.push(
      `Una cita: ${nameOf(b)}, ${b.service.toLowerCase()}, el ${weekday(b.scheduled_at, tz)} a las ${spanishClock(b.scheduled_at, tz)}, por ${money(b.price_estimate)}.`,
    );
  } else {
    const list = upcoming
      .slice(0, 3)
      .map((b) => `${nameOf(b)} el ${weekday(b.scheduled_at, tz)} a las ${spanishClock(b.scheduled_at, tz)} para ${b.service.toLowerCase()}`)
      .join('; ');
    parts.push(`${upcoming.length} citas${upcoming.length > 3 ? ', las primeras tres' : ''}: ${list}.`);
  }

  if (deposits > 0) {
    parts.push(`Depósitos cobrados: ${formatCents(deposits)}.`);
  } else if (data.stats.revenue > 0) {
    parts.push(`Trabajo registrado: alrededor de ${formatCents(data.stats.revenue)}.`);
  }

  const emergencies = calls.filter((c) => c.urgency === 'emergency').length;
  if (emergencies > 0) {
    parts.push(`${emergencies === 1 ? 'Una llamada marcada como emergencia' : `${emergencies} llamadas marcadas como emergencia`}.`);
  }

  if (flagged.length === 0) {
    parts.push('Ninguna llamada quedó marcada para revisar.');
  } else {
    const first = flagged[0];
    const who = first.caller_name ? first.caller_name.split(' ')[0] : 'un cliente';
    const reason = (first.flagged_reason ?? '').replace(/^[^:]*:\s*/, '').toLowerCase();
    if (flagged.length === 1) {
      parts.push(`Una llamada quedó marcada para revisar: ${who}, ${reason}. Los detalles están en el panel.`);
    } else {
      parts.push(`${flagged.length} llamadas quedaron marcadas para revisar. La primera es ${who}, ${reason}. Los detalles están en el panel.`);
    }
  }

  parts.push('Eso es todo.');
  return parts.join(' ');
}

/** The same automatic summary in plain English (docs/i18n.md). */
function fallbackScriptEn(
  business: Business,
  data: Awaited<ReturnType<typeof gather>>,
): string {
  const owner = business.owner_name?.trim() || '';
  const hi = owner ? `Hi ${owner}.` : 'Hi.';
  const tz = tzOf(business);
  const { calls, bookings, flagged, deposits } = data;
  const parts: string[] = [hi, 'This is the automatic summary of the day, built only from the call and calendar data.'];
  const day = (iso: string) => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(new Date(iso));

  if (calls.length === 0 && bookings.length === 0) {
    parts.push('There were no calls and no appointments today.', 'That is all.');
    return parts.join(' ');
  }

  if (calls.length === 0) {
    parts.push('There were no calls today.');
  } else if (calls.length === 1) {
    parts.push('There was one call today.');
  } else {
    const bilingual = calls.filter((c) => c.language === 'es' || c.language === 'mixed').length;
    let langNote = '';
    if (bilingual === calls.length) langNote = ', all of them in Spanish or in both languages';
    else if (bilingual > 0) langNote = `, ${bilingual} of them in Spanish or in both`;
    parts.push(`There were ${calls.length} calls today${langNote}.`);
  }

  const upcoming = bookings
    .filter((b) => b.status !== 'cancelled')
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));

  if (upcoming.length === 0) {
    parts.push('No appointments are recorded for today.');
  } else if (upcoming.length === 1) {
    const b = upcoming[0];
    parts.push(`One appointment: ${nameOf(b)}, ${b.service.toLowerCase()}, on ${day(b.scheduled_at)} at ${clock(b.scheduled_at, tz)}, for ${b.price_estimate == null ? 'the agreed price' : formatCents(b.price_estimate)}.`);
  } else {
    const list = upcoming
      .slice(0, 3)
      .map((b) => `${nameOf(b)} on ${day(b.scheduled_at)} at ${clock(b.scheduled_at, tz)} for ${b.service.toLowerCase()}`)
      .join('; ');
    parts.push(`${upcoming.length} appointments${upcoming.length > 3 ? ', the first three' : ''}: ${list}.`);
  }

  if (deposits > 0) {
    parts.push(`Deposits collected: ${formatCents(deposits)}.`);
  } else if (data.stats.revenue > 0) {
    parts.push(`Work recorded: about ${formatCents(data.stats.revenue)}.`);
  }

  const emergencies = calls.filter((c) => c.urgency === 'emergency').length;
  if (emergencies > 0) {
    parts.push(`${emergencies === 1 ? 'One call was marked as an emergency' : `${emergencies} calls were marked as emergencies`}.`);
  }

  if (flagged.length === 0) {
    parts.push('No call is flagged for review.');
  } else {
    const first = flagged[0];
    const who = first.caller_name ? first.caller_name.split(' ')[0] : 'a customer';
    const reason = (first.flagged_reason ?? '').replace(/^[^:]*:\s*/, '').toLowerCase();
    if (flagged.length === 1) {
      parts.push(`One call is flagged for review: ${who}, ${reason}. The details are on the dashboard.`);
    } else {
      parts.push(`${flagged.length} calls are flagged for review. The first is ${who}, ${reason}. The details are on the dashboard.`);
    }
  }

  parts.push('That is all.');
  return parts.join(' ');
}

async function narrate(
  business: Business,
  data: Awaited<ReturnType<typeof gather>>,
  date: string,
  locale: Locale = 'es',
): Promise<{ text: string; narration: 'ai' | 'automatic' }> {
  const fallback = fallbackScript(business, data, locale);
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

  const { value, mocked } = await generateTextSafe(
    [
      {
        role: 'system',
        content:
          'Use ONLY the facts in the data: never claim an action, a customer reaction or a result that is not in it (nothing was "prepared", "handled completely" or "resolved" unless the data says so). ' +
          `You write a 45-second voice note from an AI receptionist to the owner of a small local ${packOf(business).label.en.toLowerCase()} business called "${business.name}". ` +
          (locale === 'en'
            ? 'Write in natural, warm ENGLISH (a Spanish word here and there is fine if the owner would say it). Spoken, first person. 110-140 words. No bullet points, no headers, no markdown. ' +
              'Open with "Hi" and the owner\'s name from the data (just "Hi." when the owner is null). Name the real bookings with real times. Say the money collected. ' +
              'End with the ONE thing needing attention, or say nothing is pending. Close with "That is all."'
            : `Write in natural SPANGLISH — Spanish sentence structure with the English trade words this business would use (${packOf(business).briefing.tradeWords}). ` +
              'Warm, spoken, first person. 110-140 words. No bullet points, no headers, no markdown. ' +
              'Open with "Hola" and the owner\'s name from the data (just "Hola." when the owner is null). Name the real bookings with real times. Say the money collected. ' +
              'End with the ONE thing needing attention, or say nothing is pending. Close with "Eso es todo."'),
      },
      {
        role: 'user',
        content: `Here is the day's data as JSON:\n${JSON.stringify(facts, null, 2)}\n\nWrite only the spoken script.`,
      },
    ],
    fallback,
    0.6,
  );

  if (mocked) return { text: fallback, narration: 'automatic' }; // no key or a provider failure: the automatic summary, labelled as such
  const words = wordCount(value);
  // Guard the length contract; a runaway model would blow past the 45 seconds.
  if (words < MIN_WORDS || words > MAX_WORDS) {
    log.warn('narrate.words_out_of_range', { words, min: MIN_WORDS, max: MAX_WORDS, used_fallback: true });
    return { text: fallback, narration: 'automatic' };
  }
  log.debug('narrate.ok', { words });
  return { text: value.trim(), narration: 'ai' };
}

/** Outcome of the audio step of a briefing: the dashboard shows an honest "audio unavailable" for anything but `ready`. */
export type BriefingAudioOutcome =
  | { status: 'ready'; bytes: number }
  | { status: 'unavailable'; reason: TtsFailure };

/**
 * Synthesize the briefing's audio with the business's voice and store it in the database (briefing_audio). On ANY failure the briefing has no audio
 * (stale audio of an older transcript is deleted too) and the reason is returned: nothing is faked and nothing is written to disk.
 */
export async function attachBriefingAudio(business: Business, briefing: Briefing): Promise<{ briefing: Briefing; audio: BriefingAudioOutcome }> {
  const voice = await synthesizeBriefing(briefing.transcript, { voiceId: business.voice_id });
  if (!voice.ok) {
    await deleteBriefingAudio(business.id, briefing.id); // never leave the audio of a previous transcript next to a new one
    return { briefing: { ...briefing, audio_url: null }, audio: { status: 'unavailable', reason: voice.reason } };
  }
  const saved = await saveBriefingAudio(business.id, briefing.id, { content_type: voice.content_type, bytes: voice.bytes, voice_id: voice.voice_id });
  if (!saved.ok) {
    log.warn('audio.save_failed', { business: business.id, briefing: briefing.id, reason: saved.reason });
    await deleteBriefingAudio(business.id, briefing.id);
    return { briefing: { ...briefing, audio_url: null }, audio: { status: 'unavailable', reason: 'store_failed' } };
  }
  return { briefing: { ...briefing, audio_url: saved.audio_url }, audio: { status: 'ready', bytes: voice.bytes.byteLength } };
}

export async function generateBriefing(businessId: string, date?: string): Promise<Briefing & { audio?: BriefingAudioOutcome }> {
  const started = Date.now();
  const business = await getBusiness(businessId);
  if (!business) {
    log.warn('generate.business_not_found', { business: businessId });
    throw new Error('business not found');
  }

  const tz = tzOf(business);
  const day = date ?? localDateKey(new Date(), tz);
  // The date becomes a DB key: accept only a real calendar date.
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

  // Written in the owner's language (users.locale, else the business default).
  const { text: transcript, narration } = await narrate(business, data, day, await ownerLocaleFor(business));
  // The row first (text + stats + how the text was written), then the audio keyed on its id.
  const created = await createBriefing({
    business_id: businessId,
    date: day,
    transcript,
    audio_url: null,
    stats: { ...data.stats, narration },
  });
  const { briefing, audio } = await attachBriefingAudio(business, created);
  log.info('generate.done', {
    business: businessId,
    date: day,
    words: wordCount(transcript),
    narration,
    audio: audio.status,
    ...(audio.status === 'unavailable' ? { audio_reason: audio.reason } : {}),
    ms: Date.now() - started,
  });
  return { ...briefing, audio };
}

export { fallbackScript, gather, wordCount };
