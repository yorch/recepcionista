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

const EN_AI = /\b(?:AI|artificial intelligence|automated|virtual assistant)\b/i;
const EN_REC = /\brecord(?:ed|ing|ings)?\b/i;
const ES_AI = /\b(?:inteligencia artificial|IA|asistente virtual|asistente automatizado)\b/i;
const ES_REC = /\bgrab(?:ada|ado|ar|aci[oó]n|aciones)\b/i;

/** True when the text tells the caller, in BOTH served languages, that it is an AI and that the call may be recorded. */
export function hasMandatoryNotice(text: string): boolean {
  return EN_AI.test(text) && EN_REC.test(text) && ES_AI.test(text) && ES_REC.test(text);
}

/**
 * The disclosure for a business. A custom text may EXTEND the platform notice but never replace it:
 * when it does not already state the AI + recording notice (English and Spanish), the standard notice
 * is appended, so every call opens with it whatever was saved.
 */
export function disclosureFor(business: Pick<Business, 'recording_disclosure_text'>): string {
  const custom = cleanDisclosure(business.recording_disclosure_text);
  if (!custom) return DEFAULT_DISCLOSURE;
  return hasMandatoryNotice(custom) ? custom : `${custom} ${DEFAULT_DISCLOSURE}`;
}

const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Server-side evidence that the disclosure was actually the agent's opening: the agent's own first
 * message (its configured first_message, or the first AGENT turn of the transcript) contains the
 * business's effective disclosure or the standard notice. Caller speech never counts.
 */
export function disclosureSpokenIn(firstAgentMessage: string | null | undefined, business: Pick<Business, 'recording_disclosure_text'>): boolean {
  if (!firstAgentMessage) return false;
  const spoken = squash(firstAgentMessage);
  return spoken.includes(squash(disclosureFor(business))) || spoken.includes(squash(DEFAULT_DISCLOSURE_EN));
}
