/**
 * The pure model of the /admin/providers page (agent B): card status from the field views, which tests a card offers, whether a candidate secret may be saved,
 * the Stripe orphan arithmetic and the batch loop of the follow-up actions (re-sync agents / repair numbers). No React, no I/O: unit tested in
 * tests/admin-providers-pure.test.ts. Safe in client and server bundles (types only from the server modules).
 */
import { CARDS, PAIRS, type CardDef, type TestId } from './provider-meta';

export interface FieldState {
  key: string;
  /** `SettingView.source` (env | console | default) for plain fields; for secrets the secret info source mapped (env | console | none). */
  source: 'env' | 'console' | 'default' | 'none';
  set: boolean;
}

export type CardStatus = 'locked_env' | 'console' | 'mixed' | 'unset' | 'incomplete';

/** Which field keys a card needs before it can work at all (the same sets the self-test reports as `missing`). */
export const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  telephony: ['twilio.account_sid', 'twilio.auth_token'],
  voice: ['elevenlabs.api_key'],
  payments: ['stripe.secret_key'],
  ai: [],
  email: [],
  calendar: ['google.client_id', 'google.client_secret'],
  captcha: ['signup.turnstile_site_key', 'signup.turnstile_secret_key'],
};

/**
 * One word for the card: `locked_env` (every set field comes from the environment), `console` (from the console), `mixed`, `unset` (nothing set) or `incomplete` (something
 * is set but a required field is missing). A field that merely carries a default does not count as set.
 */
export function cardStatus(cardId: string, states: readonly FieldState[]): CardStatus {
  const set = states.filter((s) => s.set && s.source !== 'default' && s.source !== 'none');
  if (set.length === 0) return 'unset';
  const required = REQUIRED[cardId] ?? [];
  const byKey = new Map(states.map((s) => [s.key, s]));
  if (required.some((k) => !byKey.get(k)?.set)) return 'incomplete';
  const env = set.filter((s) => s.source === 'env').length;
  return env === set.length ? 'locked_env' : env === 0 ? 'console' : 'mixed';
}

/** The provider tests a card runs for "Test connection", given what is configured (only a configured provider is called). */
export function testsFor(card: CardDef, isSet: (key: string) => boolean, valueOf: (key: string) => unknown): TestId[] {
  switch (card.id) {
    case 'ai': return [...(isSet('llm.openai_api_key') ? ['openai' as const] : []), ...(isSet('llm.anthropic_api_key') ? ['anthropic' as const] : [])];
    case 'email': { const p = valueOf('email.provider'); return p === 'resend' ? ['resend'] : p === 'smtp' ? ['smtp'] : []; }
    default: return card.tests.slice(0, 1);
  }
}

/** The plain partners (ids) that travel with a secret in one change set. */
export const partnersOf = (secretKey: string): readonly string[] => PAIRS[secretKey] ?? [];
export const isPartnerField = (key: string): boolean => Object.values(PAIRS).some((l) => l.includes(key));
export const cardOfSecret = (key: string): CardDef | undefined => CARDS.find((c) => c.fields.some((f) => f.key === key && f.role === 'secret'));

// ---- candidate testing ------------------------------------------------------------------------------------------------------------------------

export interface TestSummary {
  outcome: 'ok' | 'auth_failed' | 'unreachable' | 'misconfigured';
  mode_changed?: boolean | null;
  account_changed?: boolean | null;
  orphaned_businesses?: number;
}

/** Businesses that would lose their Stripe customer: only a mode or account switch counts (mirrors the server rule `stripeOrphanRisk`). */
export function orphanRisk(r: TestSummary | null): number {
  if (!r || r.outcome !== 'ok') return 0;
  return r.mode_changed === true || r.account_changed !== false ? r.orphaned_businesses ?? 0 : 0;
}

export interface SaveGate {
  /** A test is required for this secret (the provider has an endpoint that accepts it). */
  testRequired: boolean;
  result: TestSummary | null;
  /** The candidate (and its paired inputs) is exactly what was tested. */
  sameAsTested: boolean;
  acceptUnreachable: boolean;
  orphans: number;
  acknowledged: boolean;
  confirmOk: boolean;
  /** The server preview came back (reason / phrase requirements known). */
  previewReady: boolean;
}

/** May "Save" be pressed? The server enforces the same rules again (verifySecret, orphan guard, phrase); this only keeps the button honest. */
export function canSaveSecret(g: SaveGate): boolean {
  if (!g.previewReady || !g.confirmOk) return false;
  if (g.testRequired) {
    if (!g.result || !g.sameAsTested) return false;
    if (g.result.outcome === 'unreachable') { if (!g.acceptUnreachable) return false; }
    else if (g.result.outcome !== 'ok') return false;
  }
  return g.orphans === 0 || g.acknowledged;
}

// ---- batch loop (follow-ups) ------------------------------------------------------------------------------------------------------------------

export interface BatchItem { business_id: string; outcome: string; detail?: string }
export interface BatchPage { items: BatchItem[]; next_cursor: string | null }
export interface BatchProgress { processed: number; pages: number; counts: Record<string, number>; failed: BatchItem[] }
export interface BatchOutcome extends BatchProgress { completed: boolean; stopped: boolean; error: unknown }

export const MAX_BATCH_PAGES = 4000;
const FAIL_KEEP = 50;

/**
 * Walk `next_cursor` until the server says there is no more (or the caller stops after the current batch). One batch per call, so the operator never curls cursors by hand.
 * A cursor that does not move is a server bug and ends the loop (never an endless loop). A thrown error stops the loop and is returned (the progress so far is kept).
 */
export async function runBatches(call: (cursor: string | null) => Promise<BatchPage>, opts: { shouldStop?: () => boolean; onProgress?: (p: BatchProgress) => void } = {}): Promise<BatchOutcome> {
  const p: BatchProgress = { processed: 0, pages: 0, counts: {}, failed: [] };
  let cursor: string | null = null;
  let error: unknown = null;
  let completed = false;
  let stopped = false;
  for (;;) {
    if (opts.shouldStop?.()) { stopped = true; break; }
    if (p.pages >= MAX_BATCH_PAGES) break;
    let page: BatchPage;
    try { page = await call(cursor); } catch (e) { error = e; break; }
    p.pages += 1;
    for (const it of page.items) {
      p.processed += 1;
      p.counts[it.outcome] = (p.counts[it.outcome] ?? 0) + 1;
      if (it.outcome === 'failed' && p.failed.length < FAIL_KEEP) p.failed.push(it);
    }
    opts.onProgress?.({ ...p, counts: { ...p.counts }, failed: [...p.failed] });
    if (page.next_cursor === null) { completed = true; break; }
    if (page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  }
  return { ...p, completed, stopped, error };
}

/** Percent for a progress bar when the total is only an estimate (never above 99 until the run completes). */
export function estimatePercent(processed: number, total: number | null, completed: boolean): number | null {
  if (completed) return 100;
  if (!total || total <= 0) return null;
  return Math.min(99, Math.round((processed / total) * 100));
}

/** Registry key -> catalog key of its label / hint on this page. */
export const labelKeyOf = (key: string): string => `ap.f.${key}.label`;
export const hintKeyOf = (key: string): string => `ap.h.${key}`;
