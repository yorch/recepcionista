/**
 * Persistence of the per-business call handling mode (see src/lib/voice/call-mode.ts for the routing rules).
 * Every write is a conditional single-row UPDATE, so concurrent edits cannot leave a half state, and the forward number
 * and its verification always change together: a new number is NEVER verified until the SMS code is confirmed.
 *
 * Every path that can SET or USE a forward target runs the forward-number rules (validateForwardNumber: premium, short,
 * Caribbean/territory, 976, toll-free, country allow-list, own line), whatever verified it: a verified owner phone is not exempt.
 * Every function returns the state BEFORE and AFTER the write so callers audit and announce each transition, including the implicit
 * ones (a new number drops 'forward' back to 'ai').
 */
import { prisma } from './client';
import { logger } from '@/lib/log';
import { defaultPhoneCountry, phoneCountry } from '@/lib/phone';
import { forwardTarget } from '@/lib/voice/call-mode';
import { validateForwardNumber } from '@/lib/voice/forward-number';
import { forwardingSupported, lineKind, type LineKind } from '@/lib/voice/line';
import type { CallMode } from '@/lib/types';

const log = logger('db');

export interface CallModeState {
  call_mode: CallMode;
  forward_number: string | null;
  forward_number_e164: string | null;
  forward_number_verified_at: string | null;
  forward_during_hours: boolean;
}

/** The state around a write. `after` equals `before` when nothing changed. */
export interface CallModeChange { before: CallModeState; after: CallModeState }

/** A forward number that does not pass the forward-number rules (carries the user-facing reason). */
export class ForwardNumberRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'ForwardNumberRejectedError'; }
}

export type SetCallModeResult =
  | ({ ok: true; previous: CallMode; state: CallModeState } & CallModeChange)
  | { ok: false; reason: 'not_found' | 'forward_number_unverified' | 'forward_unsupported' };

type Row = {
  callMode: string; forwardNumber: string | null; forwardNumberE164: string | null; forwardNumberVerifiedAt: Date | null; forwardDuringHours: boolean;
};

const state = (r: Row): CallModeState => ({
  call_mode: r.callMode === 'paused' || r.callMode === 'forward' ? r.callMode : 'ai',
  forward_number: r.forwardNumber,
  forward_number_e164: r.forwardNumberE164,
  forward_number_verified_at: r.forwardNumberVerifiedAt ? r.forwardNumberVerifiedAt.toISOString() : null,
  forward_during_hours: r.forwardDuringHours,
});

type FullRow = Row & { phoneE164: string | null; ownerPhoneE164: string | null; ownerPhoneVerifiedAt: Date | null };

/** Is the stored target dialable right now (proven AND allowed)? Same function the phone lines use. */
const dialable = (r: FullRow) => forwardTarget({
  forward_number_e164: r.forwardNumberE164,
  forward_number_verified_at: r.forwardNumberVerifiedAt ? r.forwardNumberVerifiedAt.toISOString() : null,
  owner_phone_e164: r.ownerPhoneE164,
  owner_phone_verified_at: r.ownerPhoneVerifiedAt ? r.ownerPhoneVerifiedAt.toISOString() : null,
  phone_e164: r.phoneE164,
});

/** Run the forward-number rules for a number about to be stored for this business; throws ForwardNumberRejectedError. */
function assertAllowed(e164: string, phoneE164: string | null): void {
  const check = validateForwardNumber(e164, phoneCountry(phoneE164) ?? defaultPhoneCountry(), { ownLines: [phoneE164] });
  if (!check.ok || check.e164 !== e164) throw new ForwardNumberRejectedError(check.ok ? 'not a normalised number' : check.error);
}

/**
 * Change the mode and/or the "forward during business hours" flag. `mode` may be omitted to change only the flag (a stale mode is
 * never re-sent). 'forward' is refused unless the business has a TRUSTED forward number (verified AND passing the forward rules)
 * and this deployment's line can forward at all (the native ElevenLabs line cannot): check and write are one transaction.
 */
export async function setCallMode(
  businessId: string, mode: CallMode | undefined, opts: { forward_during_hours?: boolean; line?: LineKind } = {},
): Promise<SetCallModeResult> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId } });
    if (!cur) return { ok: false as const, reason: 'not_found' as const };
    const target = mode ?? (cur.callMode as CallMode);
    if (mode === 'forward') {
      if (!forwardingSupported(opts.line ?? lineKind(), process.env, { native_transfer_enabled: cur.nativeTransferEnabled })) return { ok: false as const, reason: 'forward_unsupported' as const };
      if (!dialable(cur).ok) return { ok: false as const, reason: 'forward_number_unverified' as const };
    }
    const row = await tx.business.update({
      where: { id: businessId },
      data: {
        ...(mode ? { callMode: mode } : {}),
        ...(opts.forward_during_hours !== undefined ? { forwardDuringHours: opts.forward_during_hours } : {}),
      },
    });
    if (mode && cur.callMode !== mode) log.info('call_mode.set', { business: businessId, from: cur.callMode, to: target });
    const before = state(cur);
    const after = state(row);
    return { ok: true as const, previous: before.call_mode, state: after, before, after };
  });
}

/**
 * Set a (route-validated) forward number. It is UNVERIFIED until setForwardNumberVerified; a mode of 'forward' falls back to 'ai'
 * (the returned change carries the implicit transition so the caller can audit it). Throws ForwardNumberRejectedError.
 */
export async function setForwardNumberUnverified(businessId: string, raw: string, e164: string): Promise<CallModeChange | null> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId } });
    if (!cur) return null;
    assertAllowed(e164, cur.phoneE164);
    if (cur.forwardNumberE164 === e164) return { before: state(cur), after: state(cur) };
    const row = await tx.business.update({
      where: { id: businessId },
      data: { forwardNumber: raw, forwardNumberE164: e164, forwardNumberVerifiedAt: null, ...(cur.callMode === 'forward' ? { callMode: 'ai' } : {}) },
    });
    return { before: state(cur), after: state(row) };
  });
}

/** The SMS code for `e164` was confirmed: store it as the forward number, verified. Throws ForwardNumberRejectedError. */
export async function setForwardNumberVerified(businessId: string, e164: string, at: Date = new Date()): Promise<CallModeChange | null> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId } });
    if (!cur) return null;
    assertAllowed(e164, cur.phoneE164);
    const row = await tx.business.update({
      where: { id: businessId },
      data: { forwardNumber: e164, forwardNumberE164: e164, forwardNumberVerifiedAt: at },
    });
    log.info('forward_number.verified', { business: businessId });
    return { before: state(cur), after: state(row) };
  });
}

/**
 * Use the already-verified owner phone as the forward number (no second SMS). Null when there is none. Throws
 * ForwardNumberRejectedError when the owner phone is not an allowed forward destination (a Caribbean or premium number is a fine
 * ALERT phone but never a forward target). Adopting a DIFFERENT number while the mode is 'forward' keeps forwarding but to the new
 * number, so the change carries both states for the audit/notification.
 */
export async function adoptOwnerPhoneAsForwardNumber(businessId: string): Promise<CallModeChange | null> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId } });
    if (!cur?.ownerPhoneE164 || !cur.ownerPhoneVerifiedAt) return null;
    assertAllowed(cur.ownerPhoneE164, cur.phoneE164);
    const row = await tx.business.update({
      where: { id: businessId },
      data: { forwardNumber: cur.ownerPhoneE164, forwardNumberE164: cur.ownerPhoneE164, forwardNumberVerifiedAt: cur.ownerPhoneVerifiedAt },
    });
    return { before: state(cur), after: state(row) };
  });
}

/** Remove the forward number; a mode of 'forward' goes back to 'ai'. */
export async function clearForwardNumber(businessId: string): Promise<CallModeChange | null> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId } });
    if (!cur) return null;
    const row = await tx.business.update({
      where: { id: businessId },
      data: {
        forwardNumber: null, forwardNumberE164: null, forwardNumberVerifiedAt: null, forwardDuringHours: false,
        ...(cur.callMode === 'forward' ? { callMode: 'ai' } : {}),
      },
    });
    return { before: state(cur), after: state(row) };
  });
}
