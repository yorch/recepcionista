import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { CARDS, GOOGLE_REDIRECT_PATH, pendingFollowUps, WEBHOOKS, webhookUrl, type FollowUpAction } from '@/lib/admin/provider-meta';
import { absoluteBaseUrl } from '@/lib/base-url';
import { pinnedByEnv, setting, settingDef } from '@/lib/config';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isSet = (key: string): boolean => { const v = setting(key as never); return typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined; };

/**
 * Everything the providers page needs that is not in GET /api/admin/settings: the webhook ADDRESSES (derived from the single base-URL resolver, read-only) with whether the
 * secret that verifies them is configured, the Google redirect derived from the base URL, how many businesses depend on each provider (numbers, agents, Stripe customers),
 * and the follow-ups that are still pending (a key that needs "re-sync agents" / "repair numbers" was changed after the last complete run). No provider call, no secret.
 * Permission: selftest.read.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'selftest.read', rate: { name: 'providers', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const base = absoluteBaseUrl();
    const followKeys = [...new Set(CARDS.flatMap((c) => c.fields.map((f) => f.key)).filter((k) => settingDef(k)?.followUp))];
    const [numbers, agents, customers, revisions, resyncDone, repairDone] = await Promise.all([
      prisma.business.count({ where: { phone: { not: null } } }),
      prisma.business.count({ where: { agentId: { not: null } } }),
      prisma.business.count({ where: { stripeCustomerId: { not: null } } }),
      prisma.platformSettingRevision.findMany({ where: { key: { in: followKeys }, at: { gte: new Date(Date.now() - 60 * 24 * 3600_000) } }, select: { key: true, at: true }, orderBy: { at: 'desc' }, take: 200 }),
      lastCompleteRun('admin.resync_agents'),
      lastCompleteRun('admin.repair_numbers'),
    ]);
    const followUps = pendingFollowUps(revisions, { resync_agents: resyncDone, repair_numbers: repairDone }, (k) => {
      const f = settingDef(k)?.followUp;
      return f === 'resync_agents' || f === 'repair_numbers' ? f : null;
    });
    const key = String(setting('stripe.secret_key') ?? '');
    return ok({
      base_url: base,
      base_url_pinned: pinnedByEnv('APP_URL') || pinnedByEnv('PUBLIC_BASE_URL'),
      webhooks: WEBHOOKS.map((w) => ({ id: w.id, card: w.card, path: w.path, url: webhookUrl(base, w.path), secret_key: w.secret ?? null, verifier_configured: w.secret ? isSet(w.secret) : null })),
      google_redirect: { url: String(setting('google.oauth_redirect_uri') ?? '').trim() || webhookUrl(base, GOOGLE_REDIRECT_PATH), overridden: isSet('google.oauth_redirect_uri') },
      usage: { numbers, agents, stripe_customers: customers, messaging_service: isSet('twilio.messaging_service_sid') },
      stripe_mode: /^(sk|rk)_live_/.test(key) ? 'live' : /^(sk|rk)_test_/.test(key) ? 'test' : null,
      follow_ups: followUps,
    });
  } catch (err) { return adminFail(err); }
}

/** When the last COMPLETE real run (not a dry run, last batch reached) of a batch action finished. */
async function lastCompleteRun(action: string): Promise<Date | null> {
  const rows = await prisma.auditEvent.findMany({ where: { action, at: { gte: new Date(Date.now() - 60 * 24 * 3600_000) } }, orderBy: { at: 'desc' }, take: 50, select: { at: true, meta: true } });
  for (const r of rows) {
    const m = (r.meta ?? {}) as { dry_run?: boolean; has_more?: boolean };
    if (m.dry_run === false && m.has_more === false) return r.at;
  }
  return null;
}

export type { FollowUpAction };
