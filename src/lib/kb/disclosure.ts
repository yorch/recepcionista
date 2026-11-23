/**
 * Recording / AI disclosure spoken at the start of every call. Pure, shared by the agent
 * first message (voice/elevenlabs), the demo fallback script and the settings UI preview.
 * Engineering mitigation, not legal advice: operators must have counsel review the wording.
 */
import type { Business } from '@/lib/types';

/** Cap for a custom disclosure so it stays a sentence or two on the phone. */
export const MAX_DISCLOSURE_LENGTH = 300;

export const DEFAULT_DISCLOSURE_EN =
  'This call is handled by an AI assistant and may be recorded and transcribed.';
export const DEFAULT_DISCLOSURE_ES =
  'Esta llamada es atendida por un asistente de inteligencia artificial y puede ser grabada y transcrita.';

export const DEFAULT_DISCLOSURE = `${DEFAULT_DISCLOSURE_EN} ${DEFAULT_DISCLOSURE_ES}`;

/** Normalise a custom disclosure: collapse whitespace, strip control chars. null when empty. */
export function cleanDisclosure(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_DISCLOSURE_LENGTH) : null;
}

/** The disclosure for a business: its own text when set, else the bilingual default. */
export function disclosureFor(business: Pick<Business, 'recording_disclosure_text'>): string {
  return cleanDisclosure(business.recording_disclosure_text) ?? DEFAULT_DISCLOSURE;
}
