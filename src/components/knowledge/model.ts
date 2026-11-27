/**
 * Editable "what she knows" model shared by onboarding review and the Brain page. Pure (no I/O).
 * UI units: prices in DOLLARS (strings), durations in minutes (strings), hours as per-day open/from/to.
 * Stored units follow src/lib/types.ts: Service.base_price is whole dollars, Hours are "HH:MM" 24h or null.
 */
import { KB_LIMITS } from '@/lib/kb/limits';
import type { Business, ExtractionResult, FAQ, Hours, KnowledgeBase, Service, Vertical } from '@/lib/types';
import { packFaqs, packOf, packPricingNotes, packServices } from '@/lib/verticals';

export const DAYS = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
] as const;
export type DayKey = (typeof DAYS)[number]['key'];

/** Counts and name / area sizes come from KB_LIMITS (src/lib/kb/limits.ts: the server's saved-list limits); the text bounds below are the editor's own, stricter. */
export const LIMITS = { services: KB_LIMITS.services, faqs: KB_LIMITS.faqs, name: KB_LIMITS.name, serviceName: 120, description: 300, question: 300, answer: 1000, notes: 1000, area: KB_LIMITS.area, areas: KB_LIMITS.areas } as const;

export interface ServiceDraft { uid: number; name: string; description: string; price: string; duration: string }
export interface FaqDraft { uid: number; question: string; answer: string }
export interface DayDraft { open: boolean; from: string; to: string }

export interface KnowledgeDraft {
  name: string;
  ownerName: string;
  serviceArea: string;
  hours: Record<DayKey, DayDraft>;
  services: ServiceDraft[];
  faqs: FaqDraft[];
  pricingNotes: string;
}

let uidCounter = 1;
export const nextUid = () => uidCounter++;

const DEFAULT_DAY: DayDraft = { open: true, from: '08:00', to: '18:00' };

export function emptyDraft(name = ''): KnowledgeDraft {
  return {
    name,
    ownerName: '',
    serviceArea: '',
    hours: Object.fromEntries(DAYS.map((d) => [d.key, { ...DEFAULT_DAY, open: d.key !== 'sunday' }])) as Record<DayKey, DayDraft>,
    services: [],
    faqs: [],
    pricingNotes: '',
  };
}

const priceToString = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? '' : String(Math.round(p * 100) / 100));

function serviceToDraft(s: Service): ServiceDraft {
  return {
    uid: nextUid(),
    name: s.name ?? '',
    description: s.description ?? '',
    price: priceToString(s.base_price),
    duration: s.duration_minutes ? String(s.duration_minutes) : '',
  };
}

function hoursToDraft(h: Hours | null | undefined): Record<DayKey, DayDraft> {
  const out = emptyDraft().hours;
  if (!h || Object.keys(h).length === 0) return out;
  for (const d of DAYS) {
    const v = h[d.key];
    out[d.key] = v ? { open: true, from: v.open, to: v.close } : { open: false, from: DEFAULT_DAY.from, to: DEFAULT_DAY.to };
  }
  return out;
}

export function draftFromServer(
  business: Pick<Business, 'name' | 'owner_name' | 'service_area' | 'hours'>,
  kb: Pick<KnowledgeBase, 'services' | 'faqs' | 'pricing_notes'> | null,
): KnowledgeDraft {
  return {
    name: business.name ?? '',
    ownerName: business.owner_name ?? '',
    serviceArea: (business.service_area ?? []).join(', '),
    hours: hoursToDraft(business.hours),
    services: (kb?.services ?? []).map(serviceToDraft),
    faqs: (kb?.faqs ?? []).map((f) => ({ uid: nextUid(), question: f.question, answer: f.answer })),
    pricingNotes: kb?.pricing_notes ?? '',
  };
}

export function draftFromExtraction(ex: ExtractionResult, ownerName = ''): KnowledgeDraft {
  return {
    name: ex.name ?? '',
    ownerName,
    serviceArea: (ex.service_area ?? []).join(', '),
    hours: hoursToDraft(ex.hours),
    services: (ex.services ?? []).map(serviceToDraft),
    faqs: (ex.faqs ?? []).map((f) => ({ uid: nextUid(), question: f.question, answer: f.answer })),
    pricingNotes: ex.pricing_notes ?? '',
  };
}

/**
 * The editable starting point for a business with no website to read: the vertical's services, FAQs, pricing notes and opening hours,
 * all still editable, in the owner's language. Nothing is saved until the owner continues.
 */
export function draftFromPack(vertical: Vertical, lang: 'en' | 'es' = 'en', ownerName = '', name = ''): KnowledgeDraft {
  const pack = packOf(vertical);
  return draftFromExtraction({
    name,
    services: packServices(pack, lang),
    hours: pack.hours,
    service_area: [],
    faqs: packFaqs(pack, lang),
    pricing_notes: packPricingNotes(pack, lang),
    confidence: 'low',
    source: 'template',
  }, ownerName);
}

/** A scraped draft keeps everything it found; only an EMPTY FAQ list or empty pricing notes are filled from the vertical's pack (still editable). */
export function withPackDefaults(draft: KnowledgeDraft, vertical: Vertical, lang: 'en' | 'es' = 'en'): KnowledgeDraft {
  const pack = packOf(vertical);
  return {
    ...draft,
    faqs: draft.faqs.length > 0 ? draft.faqs : packFaqs(pack, lang).map((f) => ({ uid: nextUid(), question: f.question, answer: f.answer })),
    pricingNotes: draft.pricingNotes.trim() ? draft.pricingNotes : packPricingNotes(pack, lang),
  };
}

// ---------------------------------------------------------------- parsing / serialising

export function parseAreas(text: string): string[] {
  return [...new Set(text.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean))];
}

/** "189", "$1,234.50" -> 1234.5; '' -> null (price on quote); invalid -> undefined. */
export function parsePrice(s: string): number | null | undefined {
  const t = s.trim().replace(/[$,\s]/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 100_000 ? n : undefined;
}

export function parseDuration(s: string): number | null | undefined {
  const t = s.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 5 && n <= 1440 ? n : undefined;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface DraftErrors {
  name?: string;
  ownerName?: string;
  serviceArea?: string;
  pricingNotes?: string;
  services: Record<number, { name?: string; price?: string; duration?: string; description?: string }>;
  faqs: Record<number, { question?: string; answer?: string }>;
  hours: Partial<Record<DayKey, string>>;
  general?: string;
}

/** Messages are inline { en, es } pairs (this module is pure and shared with the browser: see docs/i18n.md). */
export function validateDraft(d: KnowledgeDraft, opts: { requireName?: boolean; lang?: 'en' | 'es' } = {}): DraftErrors {
  const L = (en: string, es: string) => (opts.lang === 'es' ? es : en);
  const e: DraftErrors = { services: {}, faqs: {}, hours: {} };
  if (opts.requireName !== false && !d.name.trim()) e.name = L('Enter your business name.', 'Ingrese el nombre de su negocio.');
  if (d.name.length > LIMITS.name) e.name = L(`Keep the name under ${LIMITS.name} characters.`, `Mantenga el nombre en menos de ${LIMITS.name} caracteres.`);
  if (d.ownerName.length > LIMITS.name) e.ownerName = L('That name is too long.', 'Ese nombre es demasiado largo.');
  const areas = parseAreas(d.serviceArea);
  if (areas.length > LIMITS.areas || areas.some((a) => a.length > LIMITS.area)) e.serviceArea = L('Too many or too long. List cities or counties, separated by commas.', 'Son demasiadas o demasiado largas. Liste ciudades o condados, separados por comas.');
  if (d.pricingNotes.length > LIMITS.notes) e.pricingNotes = L(`Keep this under ${LIMITS.notes} characters.`, `Mantenga esto en menos de ${LIMITS.notes} caracteres.`);
  if (d.services.length > LIMITS.services) e.general = L(`At most ${LIMITS.services} services.`, `Máximo ${LIMITS.services} servicios.`);
  if (d.faqs.length > LIMITS.faqs) e.general = L(`At most ${LIMITS.faqs} questions.`, `Máximo ${LIMITS.faqs} preguntas.`);

  d.services.forEach((s, i) => {
    const se: DraftErrors['services'][number] = {};
    if (!s.name.trim()) se.name = L('Give this service a name, or remove it.', 'Póngale un nombre a este servicio o quítelo.');
    else if (s.name.length > LIMITS.serviceName) se.name = L('Name is too long.', 'El nombre es demasiado largo.');
    if (parsePrice(s.price) === undefined) se.price = L('Enter dollars like 189 or 149.50, or leave blank to quote.', 'Ingrese dólares como 189 o 149.50, o déjelo en blanco para cotizar.');
    if (parseDuration(s.duration) === undefined) se.duration = L('Minutes between 5 and 1440.', 'Minutos entre 5 y 1440.');
    if (s.description.length > LIMITS.description) se.description = L(`Under ${LIMITS.description} characters.`, `Menos de ${LIMITS.description} caracteres.`);
    if (Object.keys(se).length) e.services[i] = se;
  });
  d.faqs.forEach((f, i) => {
    const fe: DraftErrors['faqs'][number] = {};
    const q = f.question.trim();
    const a = f.answer.trim();
    if (q && !a) fe.answer = L('Add the answer, or remove this question.', 'Agregue la respuesta o quite esta pregunta.');
    if (a && !q) fe.question = L('Add the question, or remove this answer.', 'Agregue la pregunta o quite esta respuesta.');
    if (f.question.length > LIMITS.question) fe.question = L('Question is too long.', 'La pregunta es demasiado larga.');
    if (f.answer.length > LIMITS.answer) fe.answer = L('Answer is too long.', 'La respuesta es demasiado larga.');
    if (Object.keys(fe).length) e.faqs[i] = fe;
  });
  for (const day of DAYS) {
    const h = d.hours[day.key];
    if (!h.open) continue;
    if (!HHMM.test(h.from) || !HHMM.test(h.to)) e.hours[day.key] = L('Enter both times.', 'Ingrese ambas horas.');
    else if (h.to <= h.from) e.hours[day.key] = L('Closing time must be after opening time.', 'La hora de cierre debe ser posterior a la de apertura.');
  }
  return e;
}

export function hasErrors(e: DraftErrors): boolean {
  return Boolean(
    e.name || e.ownerName || e.serviceArea || e.pricingNotes || e.general
    || Object.keys(e.services).length || Object.keys(e.faqs).length || Object.keys(e.hours).length,
  );
}

export function toHours(d: KnowledgeDraft): Hours {
  const out: Hours = {};
  for (const day of DAYS) {
    const h = d.hours[day.key];
    out[day.key] = h.open ? { open: h.from, close: h.to } : null;
  }
  return out;
}

/** PATCH /api/businesses/:id body. owner_name only when set (the API rejects an empty string). */
export function toBusinessPatch(d: KnowledgeDraft): Record<string, unknown> {
  return {
    name: d.name.trim(),
    owner_name: d.ownerName.trim() || null,
    service_area: parseAreas(d.serviceArea),
    hours: toHours(d),
  };
}

export function toKnowledgePayload(d: KnowledgeDraft): { services: Service[]; faqs: FAQ[]; pricing_notes: string } {
  return {
    services: d.services.map((s) => {
      const out: Service = { name: s.name.trim() };
      if (s.description.trim()) out.description = s.description.trim();
      const price = parsePrice(s.price);
      out.base_price = price ?? null;
      const dur = parseDuration(s.duration);
      if (dur) out.duration_minutes = dur;
      return out;
    }),
    faqs: d.faqs
      .filter((f) => f.question.trim() && f.answer.trim())
      .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() })),
    pricing_notes: d.pricingNotes.trim(),
  };
}

/** Stable string of the saveable content (ignores uids): the dirty check. */
export function snapshot(d: KnowledgeDraft): string {
  return JSON.stringify([
    d.name.trim(), d.ownerName.trim(), parseAreas(d.serviceArea), d.hours,
    d.services.map((s) => [s.name.trim(), s.description.trim(), s.price.trim(), s.duration.trim()]),
    d.faqs.map((f) => [f.question.trim(), f.answer.trim()]),
    d.pricingNotes.trim(),
  ]);
}

// ---------------------------------------------------------------- re-extract merge

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9áéíóúñü]+/g, ' ').trim();

export interface MergeSummary {
  addedServices: string[];
  addedFaqs: number;
  filledFields: number;
  /** Fields where the website says something different; your value was kept. */
  keptConflicts: number;
  addedAreas: string[];
  hoursKept: boolean;
}

/**
 * Merge a fresh extraction into the owner's current draft WITHOUT clobbering manual edits:
 * existing services/FAQs/hours/name/notes always win; the website only (a) adds services and questions
 * you do not have yet, (b) fills fields you left blank, and (c) adds service-area entries you lack.
 */
export function mergeExtraction(current: KnowledgeDraft, ex: ExtractionResult): { draft: KnowledgeDraft; summary: MergeSummary } {
  const summary: MergeSummary = { addedServices: [], addedFaqs: 0, filledFields: 0, keptConflicts: 0, addedAreas: [], hoursKept: true };
  const incoming = draftFromExtraction(ex);

  const services = current.services.map((s) => ({ ...s }));
  for (const inc of incoming.services) {
    const match = services.find((s) => norm(s.name) === norm(inc.name));
    if (!match) {
      if (services.length < LIMITS.services && inc.name.trim()) {
        services.push(inc);
        summary.addedServices.push(inc.name);
      }
      continue;
    }
    for (const f of ['description', 'price', 'duration'] as const) {
      if (!match[f].trim() && inc[f].trim()) {
        match[f] = inc[f];
        summary.filledFields += 1;
      } else if (match[f].trim() && inc[f].trim() && norm(match[f]) !== norm(inc[f])) {
        summary.keptConflicts += 1;
      }
    }
  }

  const faqs = current.faqs.map((f) => ({ ...f }));
  for (const inc of incoming.faqs) {
    if (!faqs.some((f) => norm(f.question) === norm(inc.question)) && faqs.length < LIMITS.faqs) {
      faqs.push(inc);
      summary.addedFaqs += 1;
    }
  }

  const haveAreas = parseAreas(current.serviceArea);
  const newAreas = parseAreas(incoming.serviceArea).filter((a) => !haveAreas.some((h) => norm(h) === norm(a)));
  summary.addedAreas = newAreas;

  const draft: KnowledgeDraft = {
    ...current,
    name: current.name.trim() ? current.name : incoming.name,
    serviceArea: [...haveAreas, ...newAreas].join(', '),
    services,
    faqs,
    pricingNotes: current.pricingNotes.trim() ? current.pricingNotes : incoming.pricingNotes,
  };
  if (!current.pricingNotes.trim() && incoming.pricingNotes.trim()) summary.filledFields += 1;
  return { draft, summary };
}

export function describeMerge(s: MergeSummary, lang: 'en' | 'es' = 'en'): string {
  const es = lang === 'es';
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (s.addedServices.length) parts.push(es ? n(s.addedServices.length, 'servicio nuevo', 'servicios nuevos') : n(s.addedServices.length, 'new service', 'new services'));
  if (s.addedFaqs) parts.push(es ? n(s.addedFaqs, 'pregunta nueva', 'preguntas nuevas') : n(s.addedFaqs, 'new question', 'new questions'));
  if (s.filledFields) parts.push(es ? n(s.filledFields, 'campo en blanco completado', 'campos en blanco completados') : n(s.filledFields, 'blank field filled', 'blank fields filled'));
  if (s.addedAreas.length) parts.push(es ? n(s.addedAreas.length, 'zona de servicio', 'zonas de servicio') : n(s.addedAreas.length, 'service area', 'service areas'));
  const base = parts.length ? (es ? `Se agregó: ${parts.join(', ')}.` : `Added ${parts.join(', ')}.`) : (es ? 'No hay nada nuevo en su sitio web.' : 'Nothing new on your website.');
  return s.keptConflicts ? (es ? `${base} Se conservaron sus valores donde el sitio web difiere (${s.keptConflicts}).` : `${base} Kept your values where the website differs (${s.keptConflicts}).`) : base;
}
