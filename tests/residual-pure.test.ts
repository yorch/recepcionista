/** Residual gaps of reviews 11-15: the pure parts (no database). */
import { describe, expect, test } from 'bun:test';
import { ownerBudgetId, ownerTrustOf } from '../src/lib/voice/owner/config';
import { splitTransferSeconds, transferLeadInSecs, transferStartSecs } from '../src/lib/voice/transfer';
import { pickBookingRefund, refundReconcileAfterMs } from '../src/lib/refund-service';

const turn = (t: number | null | undefined, extra: Record<string, unknown> = {}) => ({ role: 'agent', message: 'x', ...(t === undefined ? {} : { time_in_call_secs: t }), ...extra });
const xfer = { tool_calls: [{ tool_name: 'transfer_to_number' }] };

describe('owner budgets per identity class', () => {
  test('only attestation A (caller_verified === true) is "verified"; every other value is unverified', () => {
    expect(ownerTrustOf({ caller_verified: true })).toBe('verified');
    for (const v of [false, null, undefined]) expect(ownerTrustOf({ caller_verified: v })).toBe('unverified');
    expect(ownerTrustOf(null)).toBe('unverified');
  });
  test('budget ids never collide across classes or businesses', () => {
    const ids = [ownerBudgetId('b1', 'verified'), ownerBudgetId('b1', 'unverified'), ownerBudgetId('b2', 'verified'), ownerBudgetId('b2', 'unverified')];
    expect(new Set(ids).size).toBe(4);
    expect(ownerBudgetId('b1', 'verified').startsWith('b1:')).toBe(true);
  });
});

describe('transfer split (reports 12 L2, 15 L3)', () => {
  test('a missing time is absent, never "second 0"', () => {
    expect(transferStartSecs([turn(null, xfer)])).toBeNull();
    expect(transferStartSecs([turn(undefined, xfer)])).toBeNull();
    expect(transferStartSecs([turn('' as never, xfer)])).toBeNull();
    expect(transferStartSecs([turn(0, xfer)])).toBe(0);
    expect(transferStartSecs([turn(41.6, xfer)])).toBe(42);
  });
  test('lead-in = the last timed turn before the transfer turn', () => {
    expect(transferLeadInSecs([turn(0), turn(12), turn(30), turn(undefined, xfer), turn(99)])).toBe(30);
    expect(transferLeadInSecs([turn(0), turn(undefined, xfer)])).toBeNull();
    expect(transferLeadInSecs([turn(undefined), turn(undefined, xfer)])).toBeNull();
    expect(transferLeadInSecs('nope')).toBeNull();
  });
  test('best evidence first; the two parts always add up to the duration', () => {
    const t = [turn(0), turn(25), turn(undefined, xfer)];
    expect(splitTransferSeconds({ durationSec: 100, transcript: [turn(0), turn(10), turn(40, xfer)], dialSeconds: 90 })).toEqual({ ai: 40, forward: 60, basis: 'transfer_turn' });
    expect(splitTransferSeconds({ durationSec: 100, transcript: t, dialSeconds: 70 })).toEqual({ ai: 30, forward: 70, basis: 'dial_duration' });
    expect(splitTransferSeconds({ durationSec: 100, transcript: t })).toEqual({ ai: 25, forward: 75, basis: 'last_turn' });
    expect(splitTransferSeconds({ durationSec: 100, transcript: [turn(undefined, xfer)] })).toEqual({ ai: 0, forward: 100, basis: 'whole_call' });
    for (const [duration, dial, at] of [[100, 500, null], [100, 0, null], [10, null, 40], [0, 30, null], [100, 100, null]] as [number, number | null, number | null][]) {
      const r = splitTransferSeconds({ durationSec: duration, transcript: [turn(at ?? undefined, xfer)], dialSeconds: dial });
      expect(r.ai + r.forward).toBe(duration);
      expect(r.ai).toBeGreaterThanOrEqual(0);
      expect(r.forward).toBeGreaterThanOrEqual(0);
    }
    expect(splitTransferSeconds({ durationSec: 100, transcript: t, dialSeconds: 0 }).basis).toBe('last_turn'); // 0 bridged seconds is "unknown", not "no forward"
  });
});

describe('refund recovery (report 13 H2)', () => {
  const r = (id: string, status: string, amount = 5000, booking: string | null = 'bk1') => ({ id, status, amount_cents: amount, booking_id: booking });
  test('only this booking\'s refund of the pending amount is picked, best status first', () => {
    expect(pickBookingRefund([], 'bk1', 5000)).toBeNull();
    expect(pickBookingRefund([r('a', 'succeeded', 5000, 'other'), r('b', 'succeeded', 1000), r('c', 'succeeded', 5000, null)], 'bk1', 5000)).toBeNull();
    expect(pickBookingRefund([r('f', 'failed'), r('p', 'pending'), r('s', 'succeeded')], 'bk1', 5000)?.id).toBe('s');
    expect(pickBookingRefund([r('f', 'failed'), r('p', 'requires_action')], 'bk1', 5000)?.id).toBe('p');
    expect(pickBookingRefund([r('f', 'failed')], 'bk1', 5000)?.id).toBe('f');
  });
  test('the reconcile threshold is hours, 1..720, default 6', () => {
    expect(refundReconcileAfterMs({})).toBe(6 * 3_600_000);
    expect(refundReconcileAfterMs({ REFUND_RECONCILE_AFTER_HOURS: '12' })).toBe(12 * 3_600_000);
    for (const bad of ['0', '-1', '721', 'x', '1.5', '']) expect(refundReconcileAfterMs({ REFUND_RECONCILE_AFTER_HOURS: bad })).toBe(6 * 3_600_000);
  });
});
