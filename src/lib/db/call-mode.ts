/**
 * Persistence of the per-business call handling mode (see src/lib/voice/call-mode.ts for the routing rules).
 * Every write is a conditional single-row UPDATE, so concurrent edits cannot leave a half state, and the forward number
 * and its verification always change together: a new number is NEVER verified until the SMS code is confirmed.
 */
import { prisma } from './client';
import { logger } from '@/lib/log';
import { trustedForwardNumber } from '@/lib/voice/call-mode';
import type { CallMode } from '@/lib/types';

const log = logger('db');

export interface CallModeState {
  call_mode: CallMode;
  forward_number: string | null;
  forward_number_e164: string | null;
  forward_number_verified_at: string | null;
  forward_during_hours: boolean;
}

export type SetCallModeResult =
  | { ok: true; previous: CallMode; state: CallModeState }
  | { ok: false; reason: 'not_found' | 'forward_number_unverified' };

const state = (r: {
  callMode: string; forwardNumber: string | null; forwardNumberE164: string | null; forwardNumberVerifiedAt: Date | null; forwardDuringHours: boolean;
}): CallModeState => ({
  call_mode: r.callMode === 'paused' || r.callMode === 'forward' ? r.callMode : 'ai',
  forward_number: r.forwardNumber,
  forward_number_e164: r.forwardNumberE164,
  forward_number_verified_at: r.forwardNumberVerifiedAt ? r.forwardNumberVerifiedAt.toISOString() : null,
  forward_during_hours: r.forwardDuringHours,
});

/**
 * Switch the mode. 'forward' is refused unless the business has a TRUSTED forward number (verified by SMS code, or the
 * verified owner phone): the check and the write happen in one transaction.
 */
export async function setCallMode(
  businessId: string, mode: CallMode, opts: { forward_during_hours?: boolean } = {},
): Promise<SetCallModeResult> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId } });
    if (!cur) return { ok: false as const, reason: 'not_found' as const };
    if (mode === 'forward') {
      const trusted = trustedForwardNumber({
        forward_number_e164: cur.forwardNumberE164,
        forward_number_verified_at: cur.forwardNumberVerifiedAt ? cur.forwardNumberVerifiedAt.toISOString() : null,
        owner_phone_e164: cur.ownerPhoneE164,
        owner_phone_verified_at: cur.ownerPhoneVerifiedAt ? cur.ownerPhoneVerifiedAt.toISOString() : null,
      });
      if (!trusted) return { ok: false as const, reason: 'forward_number_unverified' as const };
    }
    const row = await tx.business.update({
      where: { id: businessId },
      data: { callMode: mode, ...(opts.forward_during_hours !== undefined ? { forwardDuringHours: opts.forward_during_hours } : {}) },
    });
    log.info('call_mode.set', { business: businessId, from: cur.callMode, to: mode });
    return { ok: true as const, previous: state(cur).call_mode, state: state(row) };
  });
}

/** Set a (already validated) forward number. It is UNVERIFIED until setForwardNumberVerified; a mode of 'forward' falls back to 'ai'. */
export async function setForwardNumberUnverified(businessId: string, raw: string, e164: string): Promise<CallModeState | null> {
  const row = await prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId }, select: { forwardNumberE164: true, callMode: true } });
    if (!cur) return null;
    if (cur.forwardNumberE164 === e164) return tx.business.findUnique({ where: { id: businessId } });
    return tx.business.update({
      where: { id: businessId },
      data: { forwardNumber: raw, forwardNumberE164: e164, forwardNumberVerifiedAt: null, ...(cur.callMode === 'forward' ? { callMode: 'ai' } : {}) },
    });
  });
  return row ? state(row) : null;
}

/** The SMS code for `e164` was confirmed: store it as the forward number, verified. */
export async function setForwardNumberVerified(businessId: string, e164: string, at: Date = new Date()): Promise<CallModeState | null> {
  const res = await prisma.business.updateMany({
    where: { id: businessId },
    data: { forwardNumber: e164, forwardNumberE164: e164, forwardNumberVerifiedAt: at },
  });
  if (res.count === 0) return null;
  log.info('forward_number.verified', { business: businessId });
  const row = await prisma.business.findUnique({ where: { id: businessId } });
  return row ? state(row) : null;
}

/** Use the already-verified owner phone as the forward number (no second SMS). Returns null when there is none. */
export async function adoptOwnerPhoneAsForwardNumber(businessId: string): Promise<CallModeState | null> {
  const cur = await prisma.business.findUnique({ where: { id: businessId } });
  if (!cur?.ownerPhoneE164 || !cur.ownerPhoneVerifiedAt) return null;
  const row = await prisma.business.update({
    where: { id: businessId },
    data: { forwardNumber: cur.ownerPhoneE164, forwardNumberE164: cur.ownerPhoneE164, forwardNumberVerifiedAt: cur.ownerPhoneVerifiedAt },
  });
  return state(row);
}

/** Remove the forward number; a mode of 'forward' goes back to 'ai'. */
export async function clearForwardNumber(businessId: string): Promise<CallModeState | null> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUnique({ where: { id: businessId }, select: { callMode: true } });
    if (!cur) return null;
    const row = await tx.business.update({
      where: { id: businessId },
      data: {
        forwardNumber: null, forwardNumberE164: null, forwardNumberVerifiedAt: null, forwardDuringHours: false,
        ...(cur.callMode === 'forward' ? { callMode: 'ai' } : {}),
      },
    });
    return state(row);
  });
}
