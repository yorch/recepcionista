/**
 * Daily retention purge. Started once per Node process from instrumentation.ts.
 * Safe with several instances: the purge runs under a DB lease (only one runs at a time) and
 * purgeExpiredData is idempotent, so a second instance running later does nothing new.
 * Disable with RETENTION_JOB=off.
 */
import { purgeExpiredData, withLease } from '@/lib/db';
import { logger } from '@/lib/log';

const log = logger('retention');

export const RETENTION_LEASE_KEY = 'job:retention-purge';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
const LEASE_TTL_MS = 5 * 60 * 1000;

/** One guarded purge run. Never throws. */
export async function runRetentionPurge(): Promise<void> {
  try {
    const res = await withLease(RETENTION_LEASE_KEY, LEASE_TTL_MS, () => purgeExpiredData());
    if (!res.acquired) log.info('skipped', { reason: 'another instance holds the lease' });
  } catch (err) {
    log.error('failed', { err });
  }
}

let started = false;

export function startRetentionJob(): void {
  if (started || process.env.RETENTION_JOB === 'off') return;
  started = true;
  const first = setTimeout(() => {
    void runRetentionPurge();
    const daily = setInterval(() => { void runRetentionPurge(); }, DAY_MS);
    daily.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
  log.info('scheduled', { every_hours: 24 });
}
