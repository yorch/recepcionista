/**
 * Turn one structured owner request (the flat arguments of the propose_kb_change tool) into a knowledge-base patch against the CURRENT
 * knowledge base, plus the spoken read-back and the short summary. Pure. The model supplies words; this module decides what they may do:
 * only the operations below exist, every text is scanned (kb-patch.ts validateOwnerKbPatch), and the summary the owner hears and is
 * texted is built HERE from the validated values, never taken from the model.
 */
import { canonicalJson, validateOwnerKbPatch, OWNER_KB_LIMITS } from '@/lib/kb-patch';
import type { FAQ, KbPatch, KnowledgeBase, Service } from '@/lib/types';

export const OWNER_CHANGE_TYPES = ['set_service', 'remove_service', 'add_faq', 'remove_faq', 'set_notice', 'clear_notice', 'add_pricing_note'] as const;
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

export function buildOwnerChange(args: OwnerChangeArgs, kb: Pick<KnowledgeBase, 'services' | 'faqs' | 'pricing_notes'>, lang: 'en' | 'es' = 'en'): BuiltChange {
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
  } else if (type === 'set_notice' || type === 'clear_notice') {
    const kind = s(args.notice_kind) as NoticeKind;
    if (!(NOTICE_KINDS as readonly string[]).includes(kind)) return fail(es ? 'Dígame si es horario, cierres o área de servicio.' : 'Tell me whether it is hours, closures or service area.');
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

  const checked = validateOwnerKbPatch(patch, kb);
  if (!checked.ok) return fail(checked.error, checked.flagged);
  const unchanged = Object.keys(checked.patch).every((k) => canonicalJson((checked.patch as Record<string, unknown>)[k]) === canonicalJson((kb as unknown as Record<string, unknown>)[k]));
  if (unchanged) return fail(es ? 'Eso ya está así.' : 'That is already how it is.');
  const clean = summary.length > 280 ? `${summary.slice(0, 277)}...` : summary;
  const readback = es ? `Entonces: ${clean}. ¿Es correcto?` : `So: ${clean}. Is that right?`;
  return { ok: true, patch: checked.patch, summary: clean, readback, fingerprint: canonicalJson(checked.patch) };
}
