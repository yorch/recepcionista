import { describe, expect, test } from 'bun:test';
import {
  briefingSlot, hourBucket, inQuietHours, isJobName, JOB_NAMES, jobsSetting, nextBriefingAt, tickSeconds,
} from '../src/lib/jobs/schedule';
import { enabledJobs } from '../src/lib/jobs';

const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;
const at = (iso: string) => new Date(iso);

describe('briefingSlot: 18:00 in the BUSINESS zone, DST-correct', () => {
  test('New York in winter (EST, UTC-5): due from 23:00Z', () => {
    expect(briefingSlot(at('2027-01-15T22:59:00Z'), 'America/New_York')).toMatchObject({ date: '2027-01-15', due: false });
    const s = briefingSlot(at('2027-01-15T23:00:00Z'), 'America/New_York');
    expect(s).toMatchObject({ date: '2027-01-15', due: true });
    expect(s.scheduled_at.toISOString()).toBe('2027-01-15T23:00:00.000Z');
  });

  test('spring forward (2027-03-14): 18:00 is 22:00Z that day, 23:00Z the day before', () => {
    expect(briefingSlot(at('2027-03-13T22:59:00Z'), 'America/New_York').due).toBe(false);
    expect(briefingSlot(at('2027-03-13T23:00:00Z'), 'America/New_York').due).toBe(true);
    expect(briefingSlot(at('2027-03-14T21:59:00Z'), 'America/New_York')).toMatchObject({ date: '2027-03-14', due: false });
    const s = briefingSlot(at('2027-03-14T22:00:00Z'), 'America/New_York');
    expect(s).toMatchObject({ date: '2027-03-14', due: true });
    expect(s.scheduled_at.toISOString()).toBe('2027-03-14T22:00:00.000Z');
  });

  test('fall back (2027-11-07): 18:00 EST is 23:00Z, so 22:00Z (still EDT-looking) is NOT due', () => {
    expect(briefingSlot(at('2027-11-07T22:00:00Z'), 'America/New_York')).toMatchObject({ date: '2027-11-07', due: false }); // 17:00 EST
    expect(briefingSlot(at('2027-11-07T23:00:00Z'), 'America/New_York').due).toBe(true);
    expect(briefingSlot(at('2027-11-06T22:00:00Z'), 'America/New_York').due).toBe(true); // 18:00 EDT the day before
  });

  test('zones without DST and far from the server, half-hour offsets, southern hemisphere DST', () => {
    expect(briefingSlot(at('2027-06-15T12:29:00Z'), 'Asia/Kolkata').due).toBe(false);
    expect(briefingSlot(at('2027-06-15T12:30:00Z'), 'Asia/Kolkata').due).toBe(true);
    expect(briefingSlot(at('2027-06-15T01:00:00Z'), 'Pacific/Auckland')).toMatchObject({ date: '2027-06-15', due: false }); // 13:00 NZST
    expect(briefingSlot(at('2027-06-15T06:00:00Z'), 'Pacific/Auckland').due).toBe(true); // 18:00 NZST
    expect(briefingSlot(at('2027-09-25T06:00:00Z'), 'Pacific/Auckland').due).toBe(true); // before NZ DST starts (Sep 26): +12
    expect(briefingSlot(at('2027-09-26T04:59:00Z'), 'Pacific/Auckland').due).toBe(false); // +13: 17:59
    expect(briefingSlot(at('2027-09-26T05:00:00Z'), 'Pacific/Auckland').due).toBe(true);
  });

  test('the "day" is the business-local day: after local midnight it is the next date and not yet due', () => {
    expect(briefingSlot(at('2027-06-15T03:00:00Z'), 'America/New_York')).toMatchObject({ date: '2027-06-14', due: true }); // 23:00 local: still catching up
    expect(briefingSlot(at('2027-06-15T04:00:00Z'), 'America/New_York')).toMatchObject({ date: '2027-06-15', due: false }); // local midnight
  });

  test('an invalid / missing zone falls back to the default zone instead of throwing', () => {
    expect(briefingSlot(at('2027-01-15T23:00:00Z'), 'Not/AZone').due).toBe(true);
    expect(briefingSlot(at('2027-01-15T23:00:00Z'), undefined).due).toBe(true);
  });
});

describe('nextBriefingAt', () => {
  test('today if still ahead, otherwise tomorrow (across DST)', () => {
    expect(nextBriefingAt(at('2027-03-14T12:00:00Z'), 'America/New_York').toISOString()).toBe('2027-03-14T22:00:00.000Z');
    expect(nextBriefingAt(at('2027-03-13T23:30:00Z'), 'America/New_York').toISOString()).toBe('2027-03-14T22:00:00.000Z');
    expect(nextBriefingAt(at('2027-11-06T23:30:00Z'), 'America/New_York').toISOString()).toBe('2027-11-07T23:00:00.000Z');
  });
});

describe('quiet hours and hour buckets', () => {
  test('the owner notice uses the same 9pm-8am window in the business zone', () => {
    expect(inQuietHours(at('2027-01-15T23:00:00Z'), 'America/New_York')).toBe(false); // 18:00
    expect(inQuietHours(at('2027-01-16T02:00:00Z'), 'America/New_York')).toBe(true); // 21:00
    expect(inQuietHours(at('2027-01-16T13:00:00Z'), 'America/New_York')).toBe(false); // 08:00
  });
  test('hourBucket is UTC and stable inside the hour', () => {
    expect(hourBucket(at('2027-03-14T18:00:00Z'))).toBe('2027-03-14T18');
    expect(hourBucket(at('2027-03-14T18:59:59Z'))).toBe('2027-03-14T18');
    expect(hourBucket(at('2027-03-14T19:00:00Z'))).toBe('2027-03-14T19');
  });
});

describe('switches', () => {
  test('JOBS: default ON in production, OFF elsewhere; on|off override', () => {
    expect(jobsSetting(env({ NODE_ENV: 'production' }))).toEqual({ enabled: true, explicit: false });
    expect(jobsSetting(env({ NODE_ENV: 'development' }))).toEqual({ enabled: false, explicit: false });
    expect(jobsSetting(env({ NODE_ENV: 'test' }))).toEqual({ enabled: false, explicit: false });
    expect(jobsSetting(env({ NODE_ENV: 'production', JOBS: 'off' }))).toEqual({ enabled: false, explicit: true });
    expect(jobsSetting(env({ NODE_ENV: 'development', JOBS: 'on' }))).toEqual({ enabled: true, explicit: true });
    expect(jobsSetting(env({ NODE_ENV: 'production', JOBS: 'garbage' })).enabled).toBe(true); // a typo never silently disables production
  });

  test('JOBS_TICK_SECONDS: default 60, clamped, garbage ignored', () => {
    expect(tickSeconds(env())).toBe(60);
    expect(tickSeconds(env({ JOBS_TICK_SECONDS: '15' }))).toBe(15);
    expect(tickSeconds(env({ JOBS_TICK_SECONDS: '1' }))).toBe(5);
    expect(tickSeconds(env({ JOBS_TICK_SECONDS: '999999' }))).toBe(3600);
    expect(tickSeconds(env({ JOBS_TICK_SECONDS: 'abc' }))).toBe(60);
    expect(tickSeconds(env({ JOBS_TICK_SECONDS: '-4' }))).toBe(60);
  });

  test('enabledJobs: retention stays OFF unless RETENTION_JOB=on, in every mode', () => {
    expect(enabledJobs(env({ NODE_ENV: 'production' }))).toEqual(['daily_briefing', 'gratitude_sweep', 'cleanup']);
    expect(enabledJobs(env({ NODE_ENV: 'production', RETENTION_JOB: 'true' }))).not.toContain('retention'); // only the exact value "on"
    expect(enabledJobs(env({ NODE_ENV: 'production', RETENTION_JOB: 'on' }))).toEqual(['daily_briefing', 'gratitude_sweep', 'cleanup', 'retention']);
    expect(enabledJobs(env({ NODE_ENV: 'development' }))).toEqual([]);
    expect(enabledJobs(env({ NODE_ENV: 'development', RETENTION_JOB: 'on' }))).toEqual(['retention']); // works on its own, as before JOBS existed
    expect(enabledJobs(env({ NODE_ENV: 'development', JOBS: 'on' }))).toEqual(['daily_briefing', 'gratitude_sweep', 'cleanup']);
    expect(enabledJobs(env({ NODE_ENV: 'production', JOBS: 'off', RETENTION_JOB: 'on' }))).toEqual([]); // explicit off wins
  });

  test('job names', () => {
    expect([...JOB_NAMES]).toEqual(['daily_briefing', 'gratitude_sweep', 'cleanup', 'retention']);
    expect(isJobName('cleanup')).toBe(true);
    expect(isJobName('rm -rf')).toBe(false);
    expect(isJobName(undefined)).toBe(false);
  });
});
