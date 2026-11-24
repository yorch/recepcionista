/**
 * Daily retention purge. Started once per Node process from instrumentation.ts.
 *
 * OFF BY DEFAULT. Deleting customer data must be a decision, not a side effect of upgrading: every existing
 * business has `retention_days = 365`, so the first run after an upgrade would silently delete (and anonymise)
 * everything older than a year. Set RETENTION_JOB=on once the retention window of each business has been reviewed
 * (Dashboard > Settings). While it is off, boot logs a loud warning with the counts a purge WOULD remove, and an
 * admin can inspect or run it by hand: POST /api/admin/retention { "dry_run": true | false }.
 *
 * The schedule (daily, first pass shortly after boot) is driven by the shared job runner (src/lib/jobs); this file keeps the purge,
 * the lease and the OFF-by-default switch. An unset JOBS leaves the purge working on its own in development; JOBS=off disables it too.
 *
 * Safe with several instances: the purge runs under a DB lease (only one runs at a time) and purgeExpiredData
 * is idempotent, so a second instance running later does nothing new.
 */
import { previewExpiredData, purgeExpiredData, withLease } from '@/lib/db';
import type { PurgeCounts } from '@/lib/db';
import { logger } from '@/lib/log';

const log = logger('retention');

export const RETENTION_LEASE_KEY = 'job:retention-purge';
const LEASE_TTL_MS = 5 * 60 * 1000;

/** Only the exact value `on` enables the automatic purge (unset, off, 1, true, typos: all stay off). */
export function retentionJobEnabled(env: string | undefined = process.env.RETENTION_JOB): boolean {
  return (env ?? '').trim().toLowerCase() === 'on';
}

/** One guarded purge run. Never throws. */
export async function runRetentionPurge(): Promise<void> {
  try {
    const res = await withLease(RETENTION_LEASE_KEY, LEASE_TTL_MS, () => purgeExpiredData());
    if (!res.acquired) log.info('skipped', { reason: 'another instance holds the lease' });
  } catch (err) {
    log.error('failed', { err });
  }
}

/** Manual run (admin endpoint): the same lease, optionally a dry run. */
export async function runRetentionNow(dryRun: boolean): Promise<{ acquired: boolean; counts?: PurgeCounts }> {
  const res = await withLease(RETENTION_LEASE_KEY, LEASE_TTL_MS, () => purgeExpiredData(new Date(), { dryRun }));
  return res.acquired ? { acquired: true, counts: res.value } : { acquired: false };
}

/** Log what a purge would remove while the job is off. Never throws. */
export async function logRetentionPreview(): Promise<void> {
  try {
    const counts = await previewExpiredData();
    const total = counts.calls + counts.sms_logs + counts.briefings + counts.bookings_anonymized;
    if (total === 0) {
      log.info('disabled', { RETENTION_JOB: 'off', would_purge: counts, note: 'nothing is past its retention window' });
      return;
    }
    log.warn('disabled_with_expired_data', {
      RETENTION_JOB: 'off',
      would_purge: counts,
      action: 'Data older than each business\'s retention_days is NOT being deleted. Review Dashboard > Settings, then set RETENTION_JOB=on. '
        + 'Inspect first with POST /api/admin/retention {"dry_run":true}.',
    });
  } catch (err) {
    log.error('preview_failed', { err });
  }
}
