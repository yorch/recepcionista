/**
 * Console housekeeping, run by the hourly `cleanup` job. Node runtime only.
 *  - previous secret envelopes kept for rollback are NULLED after 7 days (D13) in the revisions, and after the 15 minute dual-secret window on the live row;
 *  - instance heartbeats of instances not seen for a day, job_runs older than 60 days.
 */
import { prisma } from '@/lib/db/client';
import { pruneJobRuns } from './job-runs';
import { SECRET_ROLLBACK_WINDOW_MS } from './settings-store';

export async function cleanupConsoleTables(now: Date = new Date()): Promise<Record<string, number>> {
  const [revisions, previous, heartbeats, runs] = await Promise.all([
    prisma.platformSettingRevision.updateMany({ where: { prevEnvelope: { not: null }, at: { lt: new Date(now.getTime() - SECRET_ROLLBACK_WINDOW_MS) } }, data: { prevEnvelope: null } }),
    prisma.platformSetting.updateMany({ where: { previousEnvelope: { not: null }, previousUntil: { lt: now } }, data: { previousEnvelope: null, previousUntil: null } }),
    prisma.instanceHeartbeat.deleteMany({ where: { seenAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } } }),
    pruneJobRuns(now),
  ]);
  return { secret_envelopes: revisions.count, previous_secrets: previous.count, instance_heartbeats: heartbeats.count, job_runs: runs };
}
