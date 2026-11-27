/**
 * Knowledge-base size limits: the ONE place. Pure (no imports).
 *
 *  - KB_LIMITS: what a SAVED knowledge base may hold (dashboard PUT, owner-change patches). Over the limit is an error (422), never a silent cut:
 *    a tenant that edits by voice and then saves in the dashboard must not lose services 21-200 without being told.
 *  - EXTRACTION_LIMITS: how many entries the website/LLM extraction keeps when it BUILDS a first draft (a small, prompt-sized starter set;
 *    the owner can add more up to KB_LIMITS afterwards).
 *  - OWNER_VOICE_LIMITS (re-exported by kb-patch as OWNER_KB_LIMITS) are the stricter per-change bounds of the owner voice flow.
 */
export const KB_LIMITS = { services: 200, faqs: 200, text: 20_000, name: 200, short: 2_000, areas: 100, area: 100 } as const;

export const EXTRACTION_LIMITS = { services: 20, faqs: 15, areas: 15, promptClosedDates: 20 } as const;

/** A saved list over its limit: the error to answer (null when both lists fit). */
export function kbListLimitProblem(lists: { services?: unknown; faqs?: unknown }): string | null {
  if (Array.isArray(lists.services) && lists.services.length > KB_LIMITS.services) return `services must be a list of at most ${KB_LIMITS.services}`;
  if (Array.isArray(lists.faqs) && lists.faqs.length > KB_LIMITS.faqs) return `faqs must be a list of at most ${KB_LIMITS.faqs}`;
  return null;
}
