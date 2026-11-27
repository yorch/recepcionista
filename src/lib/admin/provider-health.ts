/**
 * Provider health history (server only). There is no health table: every connection test the console runs (the live selftest, the per-provider Test button) is
 * recorded as an audit row `provider.health` (target `provider:<id>`; meta `outcome`, `ms`, `tested_at`, `checks`; never a credential or a remote message) by
 * `recordProviderHealth`, de-duplicated so a page that polls does not flood the log: a new row is written when the outcome CHANGED or the last row is older than 30 minutes.
 * The history page reads them back per provider with the share of passing checks and the last good / bad moment.
 */
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/db/audit';
import { logger } from '@/lib/log';
import type { HealthOutcome, HealthOverview, HealthPoint, ProviderHealth } from './ops-model';

const log = logger('provider-health');
export const HEALTH_REPEAT_MS = 30 * 60_000;
const OUTCOMES = new Set<string>(['ok', 'auth_failed', 'unreachable', 'misconfigured']);
export const HEALTH_PROVIDERS = ['twilio', 'elevenlabs', 'stripe', 'openai', 'anthropic', 'resend', 'smtp', 'google', 'turnstile'] as const;

export interface HealthInput { provider: string; outcome: string; ms?: number | null; tested_at?: string | null; checks?: Record<string, string> | null }

const safeChecks = (c: unknown): Record<string, string> | null => {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c as Record<string, unknown>).slice(0, 12)) if (typeof v === 'string' && /^[a-z_]{1,20}$/.test(v) && /^[a-z0-9_.]{1,40}$/i.test(k)) out[k] = v;
  return Object.keys(out).length ? out : null;
};

/** Record one result (never throws). Returns true when a row was written. */
export async function recordProviderHealth(input: HealthInput, actor: { kind: 'user' | 'admin_token' | 'system'; user_id?: string | null } = { kind: 'system' }, now: Date = new Date()): Promise<boolean> {
  try {
    if (!/^[a-z]{3,20}$/.test(input.provider) || !OUTCOMES.has(input.outcome)) return false;
    const last = await prisma.auditEvent.findFirst({ where: { action: 'provider.health', target: `provider:${input.provider}` }, orderBy: { at: 'desc' }, select: { at: true, meta: true } });
    const lastMeta = (last?.meta ?? {}) as { outcome?: string; tested_at?: string };
    if (last && lastMeta.outcome === input.outcome && now.getTime() - last.at.getTime() < HEALTH_REPEAT_MS) return false;
    if (last && input.tested_at && lastMeta.tested_at === input.tested_at) return false; // the same cached result seen again
    await recordAudit({
      actor_kind: actor.kind, actor_user_id: actor.user_id ?? null, action: 'provider.health', target: `provider:${input.provider}`,
      meta_trusted: true, // every field is an enum / number / sanitized check name: the key-name scrubber would only mangle `checks`
      meta: { outcome: input.outcome, ms: typeof input.ms === 'number' ? Math.max(0, Math.round(input.ms)) : null, tested_at: input.tested_at ?? now.toISOString(), checks: safeChecks(input.checks) },
    });
    return true;
  } catch (err) {
    log.warn('record_failed', { error: (err as Error).message });
    return false;
  }
}

/** Record every tested card of a live selftest result. */
export async function recordLiveSelftest(res: { providers: { provider: string; test: { provider?: string; outcome: string; ms?: number; tested_at?: string; checks?: Record<string, string> } | null }[] }, actor?: { kind: 'user' | 'admin_token' | 'system'; user_id?: string | null }): Promise<void> {
  for (const p of res.providers) if (p.test) await recordProviderHealth({ provider: p.test.provider ?? p.provider, outcome: p.test.outcome, ms: p.test.ms, tested_at: p.test.tested_at, checks: p.test.checks }, actor);
}

export async function providerHealthOverview(q: { days?: number; provider?: string; now?: Date } = {}): Promise<HealthOverview> {
  const now = q.now ?? new Date();
  const days = Math.min(Math.max(Math.floor(q.days ?? 14), 1), 90);
  const from = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.auditEvent.findMany({
    where: { action: 'provider.health', at: { gte: from, lte: now }, ...(q.provider ? { target: `provider:${q.provider}` } : {}) },
    orderBy: { at: 'desc' }, take: 2000, select: { at: true, target: true, actorKind: true, actorUserId: true, meta: true },
  });
  const by = new Map<string, HealthPoint[]>();
  for (const r of rows) {
    const provider = r.target.replace(/^provider:/, '');
    const m = (r.meta ?? {}) as { outcome?: string; ms?: number | null; checks?: Record<string, string> | null };
    if (!m.outcome || !OUTCOMES.has(m.outcome)) continue;
    const list = by.get(provider) ?? [];
    list.push({ at: r.at.toISOString(), outcome: m.outcome as HealthOutcome, ms: typeof m.ms === 'number' ? m.ms : null, checks: safeChecks(m.checks), actor: r.actorKind === 'user' ? 'user' : r.actorKind });
    by.set(provider, list);
  }
  const names = q.provider ? [q.provider] : [...new Set([...HEALTH_PROVIDERS, ...by.keys()])];
  const providers: ProviderHealth[] = names.map((provider) => {
    const history = by.get(provider) ?? [];
    const ok = history.filter((h) => h.outcome === 'ok');
    return {
      provider, current: history[0] ?? null, checks: history.length,
      ok_pct: history.length ? Math.round((ok.length / history.length) * 1000) / 10 : null,
      last_ok_at: ok[0]?.at ?? null, last_failure_at: history.find((h) => h.outcome !== 'ok')?.at ?? null,
      history: history.slice(0, 60),
    };
  });
  return { window: { from: from.toISOString(), to: now.toISOString(), days }, providers };
}
