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

// ── Owner-driven (voice / SMS) patches: stricter than the dashboard editor ───────────────────────────────────────────────
// The owner's words reach the agent's prompt as DATA (buildSystemPrompt wraps services/faqs/pricing notes in <untrusted_data>), but a
// patch that came out of a voice conversation is still LLM output and may be forged by a caller who spoofed the owner's caller id,
// so everything the model typed is scanned before it is even proposed. Only services, FAQs and pricing notes may change: never the
// system prompt or the call script.

export const OWNER_KB_LIMITS = {
  services: 100, faqs: 100, serviceName: 80, serviceDescription: 200, question: 200, answer: 600, notes: 1_500, maxPrice: 50_000,
} as const;

export const OWNER_PATCH_KEYS = ['services', 'faqs', 'pricing_notes'] as const;

/** Tool / function names the agent knows: the owner has no reason to put them in business text. */
const TOOL_WORDS = [
  'check_availability', 'create_booking', 'send_sms', 'create_payment_link', 'flag_emergency', 'get_pricing', 'handoff_to_human',
  'propose_kb_change', 'list_recent_changes', 'undo_last_change',
];

/** Fold text for phrase matching: NFKC, accents and case folded, leetspeak digits mapped, punctuation to spaces. */
export function foldForScan(text: string): string {
  return text
    .normalize('NFKC').toLowerCase()
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/[​-‏⁠﻿­]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/@/g, 'a')
    .replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const INJECTION: RegExp[] = [
  /\b(ignore|ignora|ignorar|disregard|forget|olvida|olvidar|override|bypass|skip|omite)\b.{0,40}\b(previous|prior|above|earlier|former|all|any|your|the|these|those|anteriores?|previas?|todas?|tus|las|sus)\b.{0,30}\b(instructions?|prompts?|rules?|directions?|guidelines?|instrucciones|reglas|indicaciones|restrictions?)\b/,
  /\b(system|developer|hidden|initial|original)\s+(prompt|message|instructions?)\b/,
  /\b(new|updated|revised|real|actual|nuevas?)\s+(instructions?|instrucciones|rules?|orders?)\b/,
  /\b(you are now|you must now|from now on|starting now|a partir de ahora|ahora eres|ahora tu eres|act as|acts as|actua como|pretend (to be|you)|roleplay|role play|jailbreak|developer mode|dan mode|do anything now)\b/,
  /\b(reveal|show|print|repeat|leak|dump|muestra|revela)\b.{0,30}\b(prompt|instructions?|instrucciones|secrets?|keys?|tokens?|passwords?)\b/,
  /\b(ask|request|collect|pide|solicita|obtain)\b.{0,30}\b(card number|credit card number|cvv|cvc|ssn|social security|password|pin code|bank account|routing number)\b/,
  /\b(card number|cvv|cvc|social security|password)\b/,
  /\b(the|this) (caller|customer|user) (is|are) (the )?(owner|admin|administrator)\b/,
];

/** Raw (unfolded) markers: chat-template / role markup and code fences. */
const RAW_MARKERS: RegExp[] = [
  /^\s*(system|assistant|user|developer|human|ai|tool|function)\s*[:>]/im,
  /<\|[^>]*\|>/, /\[\/?(inst|system|sys)\]/i, /<<\s*\/?sys\s*>>/i, /<\/?\s*(untrusted_data|system|assistant|user|tool|prompt|instructions?)\b/i,
  /```/, /^\s*#{2,}\s/m,
];

const URL_RE = /(?:https?:\/\/|www\.|ftp:|data:|javascript:)|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|us|app|dev|ly|me|biz|info|xyz|ai|gov|edu|mx|es|ru|cn|tk|link|click|site|online|shop|store)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
/** A phone number in free text (the agent could be told to text/call it). No allowance: say it in the dashboard instead. */
const PHONE_RES: RegExp[] = [
  /\+\d[\d\s().-]{7,}\d/, /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, /\b\d{3}[\s.-]\d{4}\b/, /\d{7,}/,
  /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)[\s,.-]+){6,}/i,
];
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/;

export type OwnerTextProblem = 'injection' | 'url' | 'phone' | 'control' | 'tool_name' | 'too_long' | 'empty';

/** Why a piece of free text may not be saved from an owner conversation (null = fine). */
export function ownerTextProblem(text: string, max: number): OwnerTextProblem | null {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  if (text.length > max) return 'too_long';
  if (CONTROL_RE.test(text)) return 'control';
  if (URL_RE.test(text) || EMAIL_RE.test(text)) return 'url';
  if (PHONE_RES.some((re) => re.test(text))) return 'phone';
  const lowered = text.toLowerCase();
  if (TOOL_WORDS.some((t) => lowered.includes(t) || lowered.includes(t.replace(/_/g, ' ')) || lowered.includes(t.replace(/_/g, '-')))) return 'tool_name';
  if (RAW_MARKERS.some((re) => re.test(text))) return 'injection';
  const folded = foldForScan(text);
  const squashed = folded.replace(/\s/g, '');
  if (INJECTION.some((re) => re.test(folded))) return 'injection';
  if (/ignore(all|any)?(the)?(previous|prior|above|your)?(instructions|rules|prompt)/.test(squashed) || /systemprompt/.test(squashed)) return 'injection';
  return null;
}

export type OwnerPatchResult =
  | { ok: true; patch: KbPatch }
  | { ok: false; error: string; /** true when the text looks like an attack (counts toward the lockout), false for an ordinary mistake. */ flagged: boolean };

const PROBLEM_TEXT: Record<OwnerTextProblem, string> = {
  injection: 'it looks like an instruction to the assistant rather than business information',
  url: 'it contains a web address or email, which I cannot save by phone',
  phone: 'it contains a phone number, which I cannot save by phone; use the dashboard for that',
  control: 'it contains unusual characters',
  tool_name: 'it mentions internal assistant functions',
  too_long: 'it is too long',
  empty: 'it is empty',
};
const FLAGGED: ReadonlySet<OwnerTextProblem> = new Set(['injection', 'tool_name', 'control']);

/**
 * Validate a patch that came out of an owner conversation (voice or SMS) against the CURRENT knowledge base. Only items that are new or
 * different from what is stored are scanned (existing content is already trusted); counts and lengths are capped; the system prompt and
 * call script can never be touched.
 */
export function validateOwnerKbPatch(raw: unknown, current: Pick<KnowledgeBase, 'services' | 'faqs' | 'pricing_notes'>): OwnerPatchResult {
  if (isObj(raw)) {
    const extra = Object.keys(raw).filter((k) => !(OWNER_PATCH_KEYS as readonly string[]).includes(k));
    if (extra.length) return { ok: false, error: `only services, FAQs and pricing notes can be changed by phone (not ${extra.join(', ')})`, flagged: extra.some((k) => k === 'system_prompt' || k === 'call_script') };
  }
  const base = validateKbPatch(raw);
  if (!base.ok) return { ok: false, error: base.error, flagged: false };
  const patch = base.patch;
  const bad = (field: string, p: OwnerTextProblem): OwnerPatchResult => ({ ok: false, error: `${field}: ${PROBLEM_TEXT[p]}`, flagged: FLAGGED.has(p) });
  const had = (list: unknown[], item: unknown) => list.some((x) => kbValuesEqual(x, item));

  if (patch.services) {
    if (patch.services.length > Math.max(OWNER_KB_LIMITS.services, current.services.length)) return { ok: false, error: 'too many services', flagged: false };
    for (const s of patch.services) {
      if (had(current.services, s)) continue;
      const checks: [string, string | undefined, number][] = [['service name', s.name, OWNER_KB_LIMITS.serviceName], ['service description', s.description, OWNER_KB_LIMITS.serviceDescription]];
      for (const [label, text, max] of checks) {
        if (text === undefined) continue;
        const p = ownerTextProblem(text, max);
        if (p && !(p === 'empty' && label === 'service description')) return bad(label, p);
      }
      if (s.base_price != null && s.base_price > OWNER_KB_LIMITS.maxPrice) return { ok: false, error: 'service price is too high', flagged: false };
    }
  }
  if (patch.faqs) {
    if (patch.faqs.length > Math.max(OWNER_KB_LIMITS.faqs, current.faqs.length)) return { ok: false, error: 'too many FAQs', flagged: false };
    for (const f of patch.faqs) {
      if (had(current.faqs, f)) continue;
      const q = ownerTextProblem(f.question, OWNER_KB_LIMITS.question);
      if (q) return bad('FAQ question', q);
      const a = ownerTextProblem(f.answer, OWNER_KB_LIMITS.answer);
      if (a) return bad('FAQ answer', a);
    }
  }
  if (patch.pricing_notes !== undefined && patch.pricing_notes !== current.pricing_notes) {
    const p = ownerTextProblem(patch.pricing_notes, OWNER_KB_LIMITS.notes);
    if (p) return bad('pricing notes', p);
  }
  return { ok: true, patch };
}
