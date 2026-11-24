/**
 * Turn one structured owner request (the flat arguments of the propose_kb_change tool) into a knowledge-base patch against the CURRENT
 * knowledge base, plus the spoken read-back and the short summary. Pure. The model supplies words; this module decides what they may do:
 * only the operations below exist, every text is scanned (kb-patch.ts validateOwnerKbPatch), and the summary the owner hears and is
 * texted is built HERE from the validated values, never taken from the model.
 */
import { DAY_KEYS } from '@/lib/availability';
import { canonicalJson, validateOwnerKbPatch, OWNER_KB_LIMITS } from '@/lib/kb-patch';
import { parseClock } from '@/lib/extraction';
import { addDaysToDateKey, isDateKey, localDateKey } from '@/lib/time';
import type { FAQ, Hours, KbPatch, KnowledgeBase, Service } from '@/lib/types';

/**
 * Operations the owner can ask for. set_hours / add_closed_dates / remove_closed_dates / set_service_area change the REAL business fields
 * (what availability and the booking transaction read), validated and applied together with the knowledge base. set_notice / clear_notice
 * are informational FAQ text only and never change what can be booked.
 */
export const OWNER_CHANGE_TYPES = ['set_service', 'remove_service', 'add_faq', 'remove_faq', 'set_notice', 'clear_notice', 'add_pricing_note', 'set_hours', 'add_closed_dates', 'remove_closed_dates', 'set_service_area'] as const;
export type OwnerChangeType = (typeof OWNER_CHANGE_TYPES)[number];
export const NOTICE_KINDS = ['hours', 'closure', 'service_area'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The question a notice is stored under (so a newer notice of the same kind replaces or extends the older one). */
const NOTICE_QUESTION: Record<NoticeKind, string> = {
  hours: 'What are your hours right now? (owner update)',
  closure: 'Are you closed on any days? (owner update)',
  service_area: 'Which areas do you serve? (owner update)',
};
const NOTICE_LABEL: Record<NoticeKind, { en: string; es: string }> = {
  hours: { en: 'hours', es: 'horario' }, closure: { en: 'closures', es: 'cierres' }, service_area: { en: 'service area', es: 'área de servicio' },
};

export interface OwnerChangeArgs {
  change_type?: unknown; service_name?: unknown; price?: unknown; duration_minutes?: unknown; description?: unknown;
  question?: unknown; answer?: unknown; notice_kind?: unknown; text?: unknown;
  days?: unknown; open_time?: unknown; close_time?: unknown; closed?: unknown; dates?: unknown; areas?: unknown;
}

/** The business's real fields, needed by the structured operations (hours / closures / service area). */
export interface OwnerBusinessFacts { hours: Hours; service_area: string[]; closed_dates: string[]; timezone: string; now?: Date }

const DAY_WORDS: Record<string, (typeof DAY_KEYS)[number]> = {
  sunday: 'sunday', sun: 'sunday', domingo: 'sunday', monday: 'monday', mon: 'monday', lunes: 'monday', tuesday: 'tuesday', tue: 'tuesday', tues: 'tuesday', martes: 'tuesday',
  wednesday: 'wednesday', wed: 'wednesday', miercoles: 'wednesday', thursday: 'thursday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', jueves: 'thursday',
  friday: 'friday', fri: 'friday', viernes: 'friday', saturday: 'saturday', sat: 'saturday', sabado: 'saturday',
};
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;

/** ["Mon","tuesday"] / "weekdays" / "monday, tuesday" -> day keys in week order; null when anything is not a day. */
export function parseDays(raw: unknown): (typeof DAY_KEYS)[number][] | null {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;/]|\band\b|\by\b/i) : [];
  const out = new Set<(typeof DAY_KEYS)[number]>();
  for (const it of items) {
    if (typeof it !== 'string') return null;
    const t = it.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (!t) continue;
    if (['weekdays', 'weekday', 'dias de semana'].includes(t)) WEEKDAYS.forEach((d) => out.add(d));
    else if (['weekends', 'weekend', 'fines de semana'].includes(t)) { out.add('saturday'); out.add('sunday'); }
    else if (['everyday', 'every day', 'daily', 'all', 'all days', 'todos los dias'].includes(t)) DAY_KEYS.forEach((d) => out.add(d));
    else if (DAY_WORDS[t]) out.add(DAY_WORDS[t]);
    else return null;
  }
  return out.size ? DAY_KEYS.filter((d) => out.has(d)) : null;
}

export type BuiltChange =
  | { ok: true; patch: KbPatch; summary: string; readback: string; fingerprint: string }
  | { ok: false; error: string; flagged: boolean };

const fail = (error: string, flagged = false): BuiltChange => ({ ok: false, error, flagged });
const s = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const eqi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** "99", "$99", 99.5 -> number; undefined when absent; null when not a price. */
function money(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

const fmt = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

const dayLabel = (d: string, lang: 'en' | 'es'): string => (lang === 'es'
  ? ({ sunday: 'domingo', monday: 'lunes', tuesday: 'martes', wednesday: 'miércoles', thursday: 'jueves', friday: 'viernes', saturday: 'sábado' } as Record<string, string>)[d]
  : d[0].toUpperCase() + d.slice(1));
const clockLabel = (hhmm: string, lang: 'en' | 'es'): string => {
  if (lang === 'es') return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  if (h === 24 || (h === 0 && m === 0 && hhmm === '24:00')) return 'midnight';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
/** "Thursday, December 25" read-back of a YYYY-MM-DD key (the day of the week lets the owner catch a wrong date). */
const dateLabel = (key: string, lang: 'en' | 'es'): string =>
  new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
const listLabel = (items: string[], lang: 'en' | 'es', max = 6): string => {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} ${lang === 'es' ? `y ${items.length - max} más` : `and ${items.length - max} more`}` : shown;
};

function parseDateList(raw: unknown): string[] | null {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\s]+/) : [];
  const out = new Set<string>();
  for (const it of items) {
    if (typeof it !== 'string') return null;
    const t = it.trim();
    if (!t) continue;
    if (!isDateKey(t)) return null;
    out.add(t);
  }
  return out.size > 0 && out.size <= 60 ? [...out].sort() : null;
}

function parseAreas(raw: unknown): string[] | null {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]+/) : [];
  const out: string[] = [];
  for (const it of items) {
    if (typeof it !== 'string') return null;
    const t = it.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.length > 0 ? out : null;
}

export function buildOwnerChange(
  args: OwnerChangeArgs, kb: Pick<KnowledgeBase, 'services' | 'faqs' | 'pricing_notes'>, lang: 'en' | 'es' = 'en', biz?: OwnerBusinessFacts,
): BuiltChange {
  const type = s(args.change_type) as OwnerChangeType;
  if (!(OWNER_CHANGE_TYPES as readonly string[]).includes(type)) return fail('That kind of change is not something I can make by phone.');
  const es = lang === 'es';
  let patch: KbPatch;
  let summary: string;

  if (type === 'set_service' || type === 'remove_service') {
    const name = s(args.service_name);
    if (!name) return fail(es ? 'Necesito el nombre del servicio.' : 'I need the name of the service.');
    const idx = kb.services.findIndex((x) => eqi(x.name, name));
    if (type === 'remove_service') {
      if (idx < 0) return fail(es ? `No encuentro un servicio llamado ${name}.` : `I could not find a service called ${name}.`);
      patch = { services: kb.services.filter((_, i) => i !== idx) };
      summary = es ? `Quitar el servicio ${kb.services[idx].name}` : `Remove the service ${kb.services[idx].name}`;
    } else {
      const price = money(args.price);
      if (price === null) return fail(es ? 'No entendí el precio.' : 'I did not understand the price.');
      let dur: number | undefined;
      if (args.duration_minutes !== undefined && args.duration_minutes !== null && args.duration_minutes !== '') {
        dur = Number(args.duration_minutes);
        if (!Number.isInteger(dur) || dur < 5 || dur > 1440) return fail(es ? 'No entendí la duración.' : 'I did not understand the duration.');
      }
      const description = args.description !== undefined ? s(args.description) : undefined;
      if (price === undefined && dur === undefined && !description && idx >= 0) return fail(es ? 'No me dijo qué cambiar de ese servicio.' : 'You did not say what to change about that service.');
      const base: Service = idx >= 0 ? { ...kb.services[idx] } : { name };
      if (price !== undefined) base.base_price = price;
      if (dur !== undefined) base.duration_minutes = dur;
      if (description) base.description = description;
      const services = idx >= 0 ? kb.services.map((x, i) => (i === idx ? base : x)) : [...kb.services, base];
      patch = { services };
      const bits = [
        price !== undefined ? (es ? `precio ${fmt(price)}` : `price ${fmt(price)}`) : '',
        dur !== undefined ? (es ? `${dur} minutos` : `${dur} minutes`) : '',
        description ? (es ? 'nueva descripción' : 'new description') : '',
      ].filter(Boolean).join(', ');
      summary = idx >= 0
        ? (es ? `Cambiar ${base.name}: ${bits}` : `Change ${base.name}: ${bits}`)
        : (es ? `Agregar el servicio ${base.name}${bits ? `: ${bits}` : ''}` : `Add the service ${base.name}${bits ? `: ${bits}` : ''}`);
    }
  } else if (type === 'add_faq' || type === 'remove_faq') {
    const question = s(args.question);
    if (!question) return fail(es ? 'Necesito la pregunta.' : 'I need the question.');
    const idx = kb.faqs.findIndex((x) => eqi(x.question, question));
    if (type === 'add_faq') {
      const answer = s(args.answer);
      if (!answer) return fail(es ? 'Necesito la respuesta.' : 'I need the answer.');
      const faq: FAQ = { question, answer };
      patch = { faqs: idx >= 0 ? kb.faqs.map((x, i) => (i === idx ? faq : x)) : [...kb.faqs, faq] };
      summary = es ? `${idx >= 0 ? 'Actualizar' : 'Agregar'} pregunta frecuente: ${question} -> ${answer}` : `${idx >= 0 ? 'Update' : 'Add'} FAQ: ${question} -> ${answer}`;
    } else {
      if (idx < 0) return fail(es ? 'No encuentro esa pregunta frecuente.' : 'I could not find that FAQ.');
      patch = { faqs: kb.faqs.filter((_, i) => i !== idx) };
      summary = es ? `Quitar pregunta frecuente: ${kb.faqs[idx].question}` : `Remove FAQ: ${kb.faqs[idx].question}`;
    }
  } else if (type === 'set_hours') {
    if (!biz) return fail(es ? 'No puedo cambiar el horario ahora.' : 'I cannot change the hours right now.');
    const days = parseDays(args.days);
    if (!days) return fail(es ? 'Dígame qué días, por ejemplo lunes a viernes.' : 'Tell me which days, for example Monday to Friday.');
    const closed = args.closed === true || args.closed === 'true';
    let range: { open: string; close: string } | null = null;
    if (!closed) {
      const open = parseClock(s(args.open_time)), close = parseClock(s(args.close_time));
      if (!open || !close) return fail(es ? 'Necesito la hora de apertura y de cierre.' : 'I need the opening and the closing time.');
      if (open === '24:00' || open >= close) return fail(es ? 'La hora de cierre debe ser después de la de apertura, el mismo día.' : 'The closing time must be after the opening time on the same day.');
      range = { open, close };
    }
    const hours: Hours = { ...biz.hours };
    for (const d of days) hours[d] = range ? { ...range } : null;
    const faqs = kb.faqs.filter((x) => x.question !== NOTICE_QUESTION.hours); // a leftover "owner update" hours note would now contradict the real hours
    patch = faqs.length === kb.faqs.length ? { hours } : { hours, faqs };
    const names = days.map((d) => dayLabel(d, lang)).join(', ');
    summary = range
      ? (es ? `Horario ${names}: ${clockLabel(range.open, lang)} a ${clockLabel(range.close, lang)}` : `Hours for ${names}: ${clockLabel(range.open, lang)} to ${clockLabel(range.close, lang)}`)
      : (es ? `Cerrado los días: ${names}` : `Closed every: ${names}`);
  } else if (type === 'add_closed_dates' || type === 'remove_closed_dates') {
    if (!biz) return fail(es ? 'No puedo cambiar los cierres ahora.' : 'I cannot change the closures right now.');
    const dates = parseDateList(args.dates);
    if (!dates) return fail(es ? 'Necesito las fechas exactas (año-mes-día).' : 'I need the exact dates (year-month-day).');
    const today = localDateKey(biz.now ?? new Date(), biz.timezone);
    const have = new Set(biz.closed_dates);
    if (type === 'add_closed_dates') {
      if (dates.some((d) => d < today)) return fail(es ? 'Una de esas fechas ya pasó.' : 'One of those dates has already passed.');
      if (dates.some((d) => d > addDaysToDateKey(today, 800))) return fail(es ? 'Una de esas fechas está demasiado lejos.' : 'One of those dates is too far away.');
      const fresh = dates.filter((d) => !have.has(d));
      if (fresh.length === 0) return fail(es ? 'Esos días ya están cerrados.' : 'Those days are already closed.');
      const closedDates = [...new Set([...biz.closed_dates, ...fresh])].sort().filter((d) => d >= today); // past closures are dead weight: drop them
      patch = { closed_dates: closedDates };
      const names = listLabel(fresh.map((d) => dateLabel(d, lang)), lang);
      summary = es ? `Cerrar el ${names}` : `Close on ${names}`;
    } else {
      const gone = dates.filter((d) => have.has(d));
      if (gone.length === 0) return fail(es ? 'Esas fechas no están marcadas como cerradas.' : 'Those dates are not marked closed.');
      patch = { closed_dates: biz.closed_dates.filter((d) => !gone.includes(d)) };
      const names = listLabel(gone.map((d) => dateLabel(d, lang)), lang);
      summary = es ? `Reabrir el ${names}` : `Reopen on ${names}`;
    }
  } else if (type === 'set_service_area') {
    if (!biz) return fail(es ? 'No puedo cambiar el área ahora.' : 'I cannot change the service area right now.');
    const areas = parseAreas(args.areas);
    if (!areas) return fail(es ? 'Dígame la lista de lugares que atienden.' : 'Tell me the full list of places you serve.');
    const faqs = kb.faqs.filter((x) => x.question !== NOTICE_QUESTION.service_area);
    patch = faqs.length === kb.faqs.length ? { service_area: areas } : { service_area: areas, faqs };
    summary = es ? `Área de servicio: ${listLabel(areas, lang, 8)}` : `Service area: ${listLabel(areas, lang, 8)}`;
  } else if (type === 'set_notice' || type === 'clear_notice') {
    const kind = s(args.notice_kind) as NoticeKind;
    if (!(NOTICE_KINDS as readonly string[]).includes(kind)) return fail(es ? 'Dígame si es horario, cierres o área de servicio.' : 'Tell me whether it is hours, closures or service area.');
    // A notice is words only. Hours and the service area are real settings: refuse the notice route so the prompt and the calendar cannot disagree.
    if (type === 'set_notice' && (kind === 'hours' || kind === 'service_area')) {
      return fail(es
        ? 'Para cambiar el horario o el área de servicio use el cambio de horario o de área, no un aviso.'
        : 'To change the hours or the service area I need to change the real setting, not leave a note. Tell me the days and times, or the list of places.');
    }
    const q = NOTICE_QUESTION[kind];
    const idx = kb.faqs.findIndex((x) => x.question === q);
    const label = NOTICE_LABEL[kind][lang];
    if (type === 'clear_notice') {
      if (idx < 0) return fail(es ? `No hay un aviso de ${label} que quitar.` : `There is no ${label} notice to remove.`);
      patch = { faqs: kb.faqs.filter((_, i) => i !== idx) };
      summary = es ? `Quitar el aviso de ${label}` : `Remove the ${label} notice`;
    } else {
      const text = s(args.text);
      if (!text) return fail(es ? 'Necesito el texto del aviso.' : 'I need the wording of the notice.');
      // Closures accumulate ("closed Monday", then "closed Dec 25"); hours and service area replace the previous notice.
      const answer = kind === 'closure' && idx >= 0 ? `${kb.faqs[idx].answer}; ${text}` : text;
      const faq: FAQ = { question: q, answer };
      patch = { faqs: idx >= 0 ? kb.faqs.map((x, i) => (i === idx ? faq : x)) : [...kb.faqs, faq] };
      summary = es ? `Aviso de ${label}: ${text}` : `Notice about ${label}: ${text}`;
    }
  } else { // add_pricing_note
    const text = s(args.text);
    if (!text) return fail(es ? 'Necesito el texto de la nota.' : 'I need the wording of the note.');
    const next = kb.pricing_notes.trim() ? `${kb.pricing_notes.trim()}\n${text}` : text;
    if (next.length > OWNER_KB_LIMITS.notes) return fail(es ? 'Las notas de precios ya son muy largas.' : 'The pricing notes are already too long.');
    patch = { pricing_notes: next };
    summary = es ? `Agregar nota de precios: ${text}` : `Add a pricing note: ${text}`;
  }

  const checked = validateOwnerKbPatch(patch, { ...kb, service_area: biz?.service_area });
  if (!checked.ok) return fail(checked.error, checked.flagged);
  const current: Record<string, unknown> = { ...(kb as unknown as Record<string, unknown>), ...(biz ? { hours: biz.hours, service_area: biz.service_area, closed_dates: biz.closed_dates } : {}) };
  const unchanged = Object.keys(checked.patch).every((k) => canonicalJson((checked.patch as Record<string, unknown>)[k]) === canonicalJson(current[k]));
  if (unchanged) return fail(es ? 'Eso ya está así.' : 'That is already how it is.');
  const clean = summary.length > 280 ? `${summary.slice(0, 277)}...` : summary;
  const readback = es ? `Entonces: ${clean}. ¿Es correcto?` : `So: ${clean}. Is that right?`;
  return { ok: true, patch: checked.patch, summary: clean, readback, fingerprint: canonicalJson(checked.patch) };
}
