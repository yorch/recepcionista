/**
 * Minimum content checks before go-live (PRD section 11 item 3). PURE: no I/O, usable on the server (provision gate, Brain page) and in the
 * browser (onboarding review, live as the owner edits).
 *
 *   REQUIRED (a blocker; provisioning is refused with 422 `kb_incomplete` for a non-admin):
 *     - at least 3 services with a price (> $0)
 *     - opening hours set (at least one open day)
 *     - at least 1 FAQ (a question with an answer)
 *     - a service area (the owner's own input: it is never defaulted to a county, so an unknown area is empty and required)
 *     - the owner's confirmation of the services, prices and service area (`content`; see db/content-confirmation.ts). Only when the caller
 *       says it knows the state (`content_state`), and never for a business that is already live.
 *   RECOMMENDED (a warning; never blocks): 5+ priced services, 3+ FAQs, the owner's name.
 *
 * `score` is 0-100 (weighted, partial credit): a progress meter, not a gate. Only `blockers` gate.
 */
import type { FAQ, Hours, Service, Vertical } from '@/lib/types';
import { packOf, tx } from '@/lib/verticals';

type Lang = 'en' | 'es';

export const MIN_PRICED_SERVICES = 3;
export const RECOMMENDED_PRICED_SERVICES = 5;
export const MIN_FAQS = 1;
export const RECOMMENDED_FAQS = 3;

export type ReadinessKey = 'services' | 'hours' | 'faqs' | 'service_area' | 'owner_name' | 'content';

export interface ReadinessItem {
  key: ReadinessKey;
  /** One owner-readable sentence saying what is missing and how much. */
  message: string;
}

export interface Readiness {
  /** 0-100. */
  score: number;
  blockers: ReadinessItem[];
  warnings: ReadinessItem[];
  /** True when there are no blockers. */
  ready: boolean;
}

export interface ReadinessKb { services: Pick<Service, 'name' | 'base_price'>[]; faqs: Pick<FAQ, 'question' | 'answer'>[] }
/** The business facts that live outside the KB. Omit a field to skip its check (unknown is not "missing"). */
export interface ReadinessFacts { hours?: Hours | null; service_area?: string[] | null; owner_name?: string | null; /** The business's trade: only used to give an example service in the messages (the default vertical when null). */ vertical?: Vertical | null;
  /** Has the owner confirmed the services / prices / service area (contentConfirmationState)? Omit to skip the check (unknown is not "missing"). */
  content_state?: 'unconfirmed' | 'confirmed' | 'stale' }

const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

export function kbReadiness(kb: ReadinessKb | null | undefined, facts: ReadinessFacts = {}, lang: Lang = 'en'): Readiness {
  const L = (en: string, es: string) => (lang === 'es' ? es : en);
  const services = kb?.services ?? [];
  const faqs = (kb?.faqs ?? []).filter((f) => hasText(f.question) && hasText(f.answer));
  const priced = services.filter((s) => hasText(s.name) && typeof s.base_price === 'number' && Number.isFinite(s.base_price) && s.base_price > 0).length;
  const blockers: ReadinessItem[] = [];
  const warnings: ReadinessItem[] = [];
  let score = 0;

  score += (Math.min(priced, MIN_PRICED_SERVICES) / MIN_PRICED_SERVICES) * 30;
  score += (Math.min(priced, RECOMMENDED_PRICED_SERVICES) / RECOMMENDED_PRICED_SERVICES) * 10;
  if (priced < MIN_PRICED_SERVICES) {
    const example = facts.vertical === undefined ? '' : L(` For example: ${tx(packOf(facts.vertical).services[0].name, lang)}.`, ` Por ejemplo: ${tx(packOf(facts.vertical).services[0].name, lang)}.`);
    blockers.push({ key: 'services', message: L(`Add at least ${MIN_PRICED_SERVICES} services with a starting price (you have ${priced}).${example}`, `Agregue al menos ${MIN_PRICED_SERVICES} servicios con un precio inicial (tiene ${priced}).${example}`) });
  } else if (priced < RECOMMENDED_PRICED_SERVICES) {
    warnings.push({ key: 'services', message: L(`${RECOMMENDED_PRICED_SERVICES} or more priced services lets her answer more calls (you have ${priced}).`, `${RECOMMENDED_PRICED_SERVICES} o más servicios con precio le permiten contestar más llamadas (tiene ${priced}).`) });
  }

  if (facts.hours !== undefined) {
    const open = Object.values(facts.hours ?? {}).some((d) => d && hasText(d.open) && hasText(d.close));
    if (open) score += 25;
    else blockers.push({ key: 'hours', message: L('Set your opening hours: she books only inside them.', 'Configure su horario de atención: ella agenda solo dentro de ese horario.') });
  } else score += 25;

  score += (Math.min(faqs.length, MIN_FAQS) / MIN_FAQS) * 10 + (Math.min(faqs.length, RECOMMENDED_FAQS) / RECOMMENDED_FAQS) * 10;
  if (faqs.length < MIN_FAQS) blockers.push({ key: 'faqs', message: L('Add at least 1 question and answer she can give callers.', 'Agregue al menos 1 pregunta con su respuesta que ella pueda dar a los llamantes.') });
  else if (faqs.length < RECOMMENDED_FAQS) warnings.push({ key: 'faqs', message: L(`${RECOMMENDED_FAQS} or more answers help with common questions (you have ${faqs.length}).`, `${RECOMMENDED_FAQS} o más respuestas ayudan con las preguntas comunes (tiene ${faqs.length}).`) });

  if (facts.service_area !== undefined) {
    if ((facts.service_area ?? []).some(hasText)) score += 10;
    else blockers.push({ key: 'service_area', message: L('Add the cities or counties you serve so she can tell callers when you cannot come.', 'Agregue las ciudades o condados que atiende para que ella pueda avisar a los llamantes cuando usted no pueda ir.') });
  } else score += 10;

  if (facts.content_state !== undefined && facts.content_state !== 'confirmed') {
    blockers.push({ key: 'content', message: facts.content_state === 'stale'
      ? L('Your services, prices or service area changed since you last confirmed them: confirm them again before she goes live.', 'Sus servicios, precios o zona de servicio cambiaron desde la última confirmación: confírmelos de nuevo antes de que ella empiece a atender.')
      : L('Confirm that your services, prices and service area are right: she quotes them to callers.', 'Confirme que sus servicios, precios y zona de servicio son correctos: ella se los dice a los llamantes.') });
  }

  if (facts.owner_name !== undefined) {
    if (hasText(facts.owner_name)) score += 5;
    else warnings.push({ key: 'owner_name', message: L('Add your name so she can say who will call them back.', 'Agregue su nombre para que ella pueda decir quién les devolverá la llamada.') });
  } else score += 5;

  return { score: Math.round(score), blockers, warnings, ready: blockers.length === 0 };
}

/** Readiness of a saved business + KB. */
export function readinessOf(kb: ReadinessKb | null | undefined, business: { hours?: Hours | null; service_area?: string[] | null; owner_name?: string | null; vertical?: Vertical | null }, lang: Lang = 'en', contentState?: ReadinessFacts['content_state']): Readiness {
  return kbReadiness(kb, { hours: business.hours ?? {}, service_area: business.service_area ?? [], owner_name: business.owner_name ?? null, vertical: business.vertical ?? null, ...(contentState ? { content_state: contentState } : {}) }, lang);
}

/** The editable onboarding draft (prices as dollar strings, hours per day). Mirrors components/knowledge/model.ts without importing it. */
export interface ReadinessDraft {
  ownerName: string;
  serviceArea: string;
  hours: Record<string, { open: boolean; from: string; to: string }>;
  services: { name: string; price: string }[];
  faqs: { question: string; answer: string }[];
}

export function readinessOfDraft(d: ReadinessDraft, vertical?: Vertical | null, lang: Lang = 'en'): Readiness {
  return kbReadiness(
    { services: d.services.map((s) => ({ name: s.name, base_price: Number(String(s.price).replace(/[$,\s]/g, '')) })), faqs: d.faqs },
    {
      hours: Object.fromEntries(Object.entries(d.hours).map(([k, v]) => [k, v.open ? { open: v.from, close: v.to } : null])),
      service_area: d.serviceArea.split(/[,\n;]/).map((a) => a.trim()).filter(Boolean),
      owner_name: d.ownerName,
      ...(vertical !== undefined ? { vertical } : {}),
    },
    lang,
  );
}
