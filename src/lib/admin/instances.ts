/** Instances overview (server only): the heartbeat table as the Instances page needs it. */
import { prisma } from '@/lib/db/client';
import { INSTANCE_ALIVE_MS, type InstancesOverview } from './ops-model';

export async function instancesOverview(now: Date = new Date()): Promise<InstancesOverview> {
  const [state, beats] = await Promise.all([prisma.settingsState.findUnique({ where: { id: 1 } }), prisma.instanceHeartbeat.findMany({ orderBy: { seenAt: 'desc' }, take: 100 })]);
  const version = Number(state?.globalVersion ?? 0);
  const instances = beats.map((b) => {
    const v = Number(b.settingsVersion);
    return {
      instance_id: b.instanceId, settings_version: v, build_sha: b.buildSha, canary: b.canary, ignored_rows: b.ignoredRows, started_at: b.startedAt.toISOString(), seen_at: b.seenAt.toISOString(),
      alive: now.getTime() - b.seenAt.getTime() < INSTANCE_ALIVE_MS, current: v === version, behind_by: Math.max(0, version - v),
    };
  });
  const live = instances.filter((i) => i.alive);
  const builds = new Map<string | null, number>();
  for (const i of live) builds.set(i.build_sha, (builds.get(i.build_sha) ?? 0) + 1);
  return { version, instances, alive: live.length, current: live.filter((i) => i.current).length, mixed_builds: builds.size > 1, builds: [...builds.entries()].map(([build_sha, count]) => ({ build_sha, count })).sort((a, b) => b.count - a.count) };
}
