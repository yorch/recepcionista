/** Pure decision logic of the canceled-tenant release (src/lib/billing/release.ts). */
import { describe, expect, test } from 'bun:test';
import { decideRelease, releaseDate, type ReleaseFacts } from '../src/lib/billing/release';

const D = (iso: string) => new Date(iso);
const NOW = D('2027-03-01T12:00:00Z');
const base = (o: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  id: 'b1', name: 'Acme', billing_status: 'canceled', plan: 'standard', period_end: D('2027-01-01T00:00:00Z'), last_comp_at: null,
  phone: '+17864129234', phone_e164: '+17864129234', agent_id: 'agent_1', recent_calls: 0, notified_at: null, has_owner_email: true,
  phone_shared: false, agent_shared: false, other_agents_exist: false, ...o,
});

describe('decideRelease', () => {
  test('only canceled/unpaid businesses are ever released', () => {
    for (const s of ['none', 'trialing', 'active', 'past_due']) expect(decideRelease(base({ billing_status: s }), { now: NOW }).action).toBe('skip');
    expect(decideRelease(base({ billing_status: 'unpaid' }), { now: NOW }).action).not.toBe('skip');
  });
  test('admin-comped plans and businesses with nothing to release are skipped', () => {
    expect(decideRelease(base({ plan: 'legacy' }), { now: NOW })).toMatchObject({ action: 'skip', reason: expect.stringContaining('comped') });
    expect(decideRelease(base({ plan: 'grandfathered' }), { now: NOW }).action).toBe('skip');
    expect(decideRelease(base({ phone: null, phone_e164: null, agent_id: null }), { now: NOW })).toMatchObject({ action: 'skip' });
  });
  test('undatable cancellations are skipped (no period end)', () => {
    expect(decideRelease(base({ period_end: null }), { now: NOW })).toMatchObject({ action: 'skip', reason: expect.stringContaining('current_period_end') });
  });
  test('grace period: waits until period end + grace days (default 30), measured from the later admin override', () => {
    const early = D('2027-01-20T00:00:00Z');
    expect(decideRelease(base(), { now: early, notifyDays: 0 })).toMatchObject({ action: 'wait', until: D('2027-01-31T00:00:00Z') });
    expect(decideRelease(base(), { now: D('2027-01-31T00:00:00Z'), notifyDays: 0 })).toEqual({ action: 'release', notice: 'off' });
    expect(releaseDate(base({ last_comp_at: D('2027-02-15T00:00:00Z') }), 30)).toEqual(D('2027-03-17T00:00:00Z'));
    expect(decideRelease(base({ last_comp_at: D('2027-02-15T00:00:00Z') }), { now: NOW, notifyDays: 0 }).action).toBe('wait');
    expect(decideRelease(base(), { now: NOW, graceDays: 90, notifyDays: 0 }).action).toBe('wait');
  });
  test('recent calls block the release unless includeRecent', () => {
    expect(decideRelease(base({ recent_calls: 3 }), { now: NOW, notifyDays: 0 })).toMatchObject({ action: 'skip', reason: expect.stringContaining('3 call') });
    expect(decideRelease(base({ recent_calls: 3 }), { now: NOW, notifyDays: 0, includeRecent: true }).action).toBe('release');
  });
  test('heads-up: nothing before the notice date, then NOTIFY once, then wait the lead time, then release', () => {
    // R = 2027-01-31; notice date (7 days before) = 2027-01-24
    expect(decideRelease(base(), { now: D('2027-01-20T00:00:00Z') })).toMatchObject({ action: 'wait', until: D('2027-01-24T00:00:00Z') });
    expect(decideRelease(base(), { now: D('2027-01-25T00:00:00Z') }).action).toBe('notify');
    const notified = D('2027-01-25T00:00:00Z');
    expect(decideRelease(base({ notified_at: notified }), { now: D('2027-01-30T00:00:00Z') })).toMatchObject({ action: 'wait' }); // before R
    expect(decideRelease(base({ notified_at: notified }), { now: D('2027-02-01T00:00:00Z') })).toEqual({ action: 'release', notice: 'sent' });
  });
  test('a late run never mails and releases in the same breath: the lead time is enforced after the notice', () => {
    const r = decideRelease(base(), { now: NOW }); // long past R, never notified
    expect(r.action).toBe('notify');
    const after = decideRelease(base({ notified_at: NOW }), { now: D('2027-03-03T00:00:00Z') });
    expect(after).toMatchObject({ action: 'wait', until: D('2027-03-08T12:00:00Z') });
    expect(decideRelease(base({ notified_at: NOW }), { now: D('2027-03-08T12:00:00Z') }).action).toBe('release');
  });
  test('no owner e-mail: cannot notify -> skipped, unless the admin skips the notice explicitly', () => {
    expect(decideRelease(base({ has_owner_email: false }), { now: NOW })).toMatchObject({ action: 'skip', reason: expect.stringContaining('email') });
    expect(decideRelease(base({ has_owner_email: false }), { now: NOW, skipNotice: true })).toEqual({ action: 'release', notice: 'skipped' });
  });
});
