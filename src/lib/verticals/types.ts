/**
 * Vertical (trade) packs: everything that differs between an HVAC company, a plumber, a dental office and so on lives in ONE pack
 * object per vertical, so the prompt builder, readiness checks, post-call logic, briefing, SMS templates and onboarding seeds all read
 * the same source (docs/verticals.md). Every human-readable text is an `L10n` ({ en, es }) so a later i18n pass can reuse the structure.
 * PURE: no I/O. The ids mirror the `businesses.vertical` CHECK constraint and `VERTICALS` in src/lib/types.ts (a test keeps them equal).
 */
import type { Hours, Vertical } from '@/lib/types';

export type { Vertical };
export type Lang = 'en' | 'es';

/** One text in both languages. */
export interface L10n { en: string; es: string }

export interface PackService {
  name: L10n;
  description: L10n;
  /** Starting price in whole dollars (> 0). */
  base_price: number;
  duration_minutes: number;
}

export interface PackFaq { question: L10n; answer: L10n }

export interface EmergencyPack {
  /** False for trades with no emergency dispatch: the prompt says so, triage is replaced by qualifying questions and post-call keywords are empty. */
  enabled: boolean;
  /** Bullet list of what counts as an emergency (prompt). The FIRST rule doubles as the "prompt is healthy" marker, see promptIsDeficient. Empty when disabled. */
  rules: L10n[];
  /** The short question list the agent asks while triaging, e.g. "water leaking? burning smell?". Empty when disabled. */
  triage: L10n;
  /** Lower-case words (English and Spanish) that make a transcript look urgent (post-call). Empty when disabled. */
  keywords: string[];
  /** The subset of `keywords` that is enough on its own to mark a call an emergency. */
  strong: string[];
  /** A vulnerable person (baby, elderly, sick) in the transcript escalates a keyword hit. */
  vulnerable: boolean;
  /** Spoken in every emergency outcome (success, failure, exception): the 911 copy. Always present, generic when the trade has no hazard of its own. */
  call911: L10n;
  /** Machine-readable hazards behind the 911 copy (tool result `call_911_for`). */
  call911For: string[];
  /** The EMERGENCIES section text when `enabled` is false; null when enabled. */
  none: L10n | null;
}

export interface VerticalPack {
  id: Vertical;
  label: L10n;
  /** One line for the onboarding picker. */
  blurb: L10n;
  /** "a home-services trade company": completes "a real human front-desk person for ...". */
  persona: L10n;
  /** Who turns up: "technician", "plumber"... */
  provider: L10n;
  services: PackService[];
  /** Opening hours seeded for a business that has not set its own. */
  hours: Hours;
  faqs: PackFaq[];
  pricing: {
    /** Default owner pricing notes (no deposit sentence: that is added from `deposits`). */
    notes: L10n;
    /** The sentence after "state the starting price ... and say ..." in the pricing rules. */
    confirmLine: L10n;
    /** Shown for a service with no price ("price on diagnosis"). */
    unpriced: L10n;
    /** The one service used when a business has none. */
    fallbackService: { name: L10n; description: L10n };
  };
  deposits: {
    /** True: the prompt tells the agent to take a deposit link as usual; false: only when the owner's pricing notes require one. */
    defaultOn: boolean;
  };
  emergency: EmergencyPack;
  prompt: {
    /** Spoken greeting, `{name}` is the business name. */
    greeting: L10n;
    /** Questions to ask while identifying the need (also the job qualifiers when there is no emergency triage). */
    qualifying: L10n[];
    /** Example of a mixed-language caller sentence and the trade words to keep as the caller says them. */
    mixExample: L10n;
    mixTerms: L10n;
  };
  /** The owner-reviewable call script. */
  script: { triage: L10n; booking: L10n };
  sms: {
    /** Used when a booking has no service name. */
    fallbackService: L10n;
    /** Optional one-line preparation note appended to the confirmation text when it fits (null: none). */
    confirmationNote: L10n | null;
  };
  briefing: {
    /** "el tech" / "el plomero": how the daily voice note refers to the person on site. */
    providerWord: L10n;
    /** Trade words the voice-note writer should keep in English. */
    tradeWords: string;
  };
  hints: {
    /** Short Spanish words typical of this trade, used to spot Spanglish transcripts. */
    spanishWords: string[];
    /** What to say on the first test call. */
    testPhrase: L10n;
    /** Placeholder for a service-name field. */
    servicePlaceholder: L10n;
  };
}

/** Required shape checks used by the tests and by `assertPack`. */
export function l10nOk(t: unknown): t is L10n {
  return !!t && typeof t === 'object'
    && typeof (t as L10n).en === 'string' && (t as L10n).en.trim().length > 0
    && typeof (t as L10n).es === 'string' && (t as L10n).es.trim().length > 0;
}
