/**
 * Pure helpers for owner knowledge-base changes: validate a patch, and compare KB values regardless of JSON key order.
 */
import type { FAQ, KbPatch, KnowledgeBase, Service } from '@/lib/types';

export const KB_PATCH_KEYS = ['services', 'faqs', 'pricing_notes', 'system_prompt', 'call_script'] as const;
export type KbPatchKey = (typeof KB_PATCH_KEYS)[number];

export const KB_LIMITS = { services: 200, faqs: 200, text: 20_000, name: 200, short: 2_000 } as const;

/** JSON with object keys sorted, so two structurally equal values compare equal (jsonb does not keep key order). */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, norm(x)]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export const kbValuesEqual = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanService(v: unknown): Service | null {
  if (!isObj(v) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > KB_LIMITS.name) return null;
  const out: Service = { name: v.name.trim() };
  if (v.description !== undefined) { if (typeof v.description !== 'string' || v.description.length > KB_LIMITS.short) return null; out.description = v.description; }
  if (v.base_price !== undefined && v.base_price !== null) { if (typeof v.base_price !== 'number' || !Number.isFinite(v.base_price) || v.base_price < 0) return null; out.base_price = v.base_price; }
  if (v.base_price === null) out.base_price = null;
  if (v.duration_minutes !== undefined) { if (typeof v.duration_minutes !== 'number' || !Number.isInteger(v.duration_minutes) || v.duration_minutes < 5 || v.duration_minutes > 24 * 60) return null; out.duration_minutes = v.duration_minutes; }
  return out;
}

function cleanFaq(v: unknown): FAQ | null {
  if (!isObj(v) || typeof v.question !== 'string' || typeof v.answer !== 'string') return null;
  if (!v.question.trim() || !v.answer.trim() || v.question.length > KB_LIMITS.short || v.answer.length > KB_LIMITS.text) return null;
  return { question: v.question.trim(), answer: v.answer };
}

export type KbPatchResult = { ok: true; patch: KbPatch } | { ok: false; error: string };

/** Validate and normalise a patch: only known keys, bounded sizes, well-formed services/faqs. Empty patches are refused. */
export function validateKbPatch(raw: unknown): KbPatchResult {
  if (!isObj(raw)) return { ok: false, error: 'patch must be an object' };
  const unknown = Object.keys(raw).filter((k) => !(KB_PATCH_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };
  const patch: KbPatch = {};
  if (raw.services !== undefined) {
    if (!Array.isArray(raw.services) || raw.services.length > KB_LIMITS.services) return { ok: false, error: 'services must be a list of at most 200' };
    const list = raw.services.map(cleanService);
    if (list.some((x) => x === null)) return { ok: false, error: 'a service is malformed' };
    patch.services = list as Service[];
  }
  if (raw.faqs !== undefined) {
    if (!Array.isArray(raw.faqs) || raw.faqs.length > KB_LIMITS.faqs) return { ok: false, error: 'faqs must be a list of at most 200' };
    const list = raw.faqs.map(cleanFaq);
    if (list.some((x) => x === null)) return { ok: false, error: 'a faq is malformed' };
    patch.faqs = list as FAQ[];
  }
  for (const k of ['pricing_notes', 'system_prompt', 'call_script'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || (raw[k] as string).length > KB_LIMITS.text) return { ok: false, error: `${k} must be text of at most 20000 characters` };
    patch[k] = raw[k] as string;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'patch changes nothing' };
  return { ok: true, patch };
}

/** The current values of the fields a patch touches (what a revert would restore). */
export function pickKbFields(kb: Pick<KnowledgeBase, KbPatchKey>, keys: readonly string[]): KbPatch {
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((KB_PATCH_KEYS as readonly string[]).includes(k)) out[k] = kb[k as KbPatchKey];
  return out as KbPatch;
}

/** Fields of `patch` whose value in `kb` differs from the patch value. */
export function kbFieldsChangedSince(kb: Pick<KnowledgeBase, KbPatchKey>, patch: KbPatch): string[] {
  return Object.keys(patch).filter((k) => !kbValuesEqual(kb[k as KbPatchKey], patch[k as KbPatchKey]));
}
