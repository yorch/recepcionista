/**
 * Vertical packs: the single place the product asks "what trade is this business?". `packOf` never throws and falls back to HVAC (the
 * original behaviour) for a missing or unknown vertical. See docs/verticals.md.
 */
import { VERTICALS, type Business, type FAQ, type Service, type Vertical } from '@/lib/types';
import { cleaning } from './packs/cleaning';
import { dental } from './packs/dental';
import { electrical } from './packs/electrical';
import { general } from './packs/general';
import { hvac } from './packs/hvac';
import { landscaping } from './packs/landscaping';
import { plumbing } from './packs/plumbing';
import type { L10n, Lang, VerticalPack } from './types';

export type { L10n, Lang, VerticalPack, PackService, PackFaq, EmergencyPack } from './types';
export { l10nOk } from './types';

export const DEFAULT_VERTICAL: Vertical = 'hvac';

export const PACKS: Readonly<Record<Vertical, VerticalPack>> = { hvac, plumbing, electrical, cleaning, landscaping, dental, general };

export function isVertical(v: unknown): v is Vertical {
  return typeof v === 'string' && (VERTICALS as readonly string[]).includes(v);
}

/** The pack of a business (or of a vertical id); HVAC when absent or unknown. */
export function packOf(input: Pick<Business, 'vertical'> | Vertical | string | null | undefined): VerticalPack {
  const id = typeof input === 'string' ? input : input?.vertical;
  return isVertical(id) ? PACKS[id] : PACKS[DEFAULT_VERTICAL];
}

/** The text in the wanted language (English when the language is unknown). */
export const tx = (t: L10n, lang: Lang = 'en'): string => (lang === 'es' ? t.es : t.en);

/** Seed services in the wanted language. */
export function packServices(pack: VerticalPack, lang: Lang = 'en'): Service[] {
  return pack.services.map((s) => ({ name: tx(s.name, lang), description: tx(s.description, lang), base_price: s.base_price, duration_minutes: s.duration_minutes }));
}

export function packFaqs(pack: VerticalPack, lang: Lang = 'en'): FAQ[] {
  return pack.faqs.map((f) => ({ question: tx(f.question, lang), answer: tx(f.answer, lang) }));
}

/** Default pricing notes of a pack, including the deposit sentence that matches `deposits.defaultOn`. */
export function packPricingNotes(pack: VerticalPack, lang: Lang = 'en'): string {
  const deposit = pack.deposits.defaultOn
    ? lang === 'es'
      ? ' Los depósitos tienen un máximo de $500 y se cobran solo con un enlace de pago seguro enviado por texto.'
      : ' Deposits are capped at $500 and collected only through a secure payment link sent by text.'
    : lang === 'es'
      ? ' No se pide depósito por defecto.'
      : ' No deposit is taken by default.';
  return `${tx(pack.pricing.notes, lang)}${deposit}`;
}

/** Words that mean danger to life in ANY vertical (post-call urgency floor; the spoken 911 rule is in every prompt too). */
export const LIFE_SAFETY_STRONG = ['gas smell', 'smell gas', 'on fire', 'house fire', 'olor a gas', 'incendio', 'monóxido', 'monoxido', 'carbon monoxide'] as const;

/** Whether the pack has emergency handling (triage, keywords, owner alerts for urgent calls). */
export const hasEmergencies = (pack: VerticalPack): boolean => pack.emergency.enabled;

/** The spoken 911 sentences of a business's vertical. */
export function call911Of(input: Pick<Business, 'vertical'> | Vertical | string | null | undefined): L10n {
  return packOf(input).emergency.call911;
}
