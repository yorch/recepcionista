import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { loaderStatus } from '@/lib/admin/loader';
import { keyInfo, reencryptStatus } from '@/lib/admin/rotation';
import { freezeState } from '@/lib/admin/settings-store';
import { allSettings, pinnedByEnv } from '@/lib/config';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * System page data: this instance's loader state (applied version, problems, canary), every instance's heartbeat ("applied on N/N"), the encryption key ids (never keys),
 * rows still under an older key, the freeze flag and how many registry keys the environment locks. Permission: system.read.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'system.read', rate: { name: 'system', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const [state, beats, frozen] = await Promise.all([prisma.settingsState.findUnique({ where: { id: 1 } }), prisma.instanceHeartbeat.findMany({ orderBy: { seenAt: 'desc' }, take: 50 }), freezeState()]);
    const version = Number(state?.globalVersion ?? 0);
    const live = beats.filter((b) => Date.now() - b.seenAt.getTime() < 90_000);
    const keys = (() => { try { return keyInfo(); } catch { return null; } })();
    return ok({
      version, frozen, loader: loaderStatus(), keys,
      reencrypt: keys ? await reencryptStatus().catch(() => null) : null,
      instances: beats.map((b) => ({ instance_id: b.instanceId, settings_version: Number(b.settingsVersion), build_sha: b.buildSha, canary: b.canary, ignored_rows: b.ignoredRows, started_at: b.startedAt.toISOString(), seen_at: b.seenAt.toISOString(), current: Number(b.settingsVersion) === version, alive: Date.now() - b.seenAt.getTime() < 90_000 })),
      applied: { instances_alive: live.length, instances_current: live.filter((b) => Number(b.settingsVersion) === version).length },
      env_locked_keys: allSettings().filter((d) => d.env && pinnedByEnv(d.env)).length,
    });
  } catch (err) { return adminFail(err); }
}
