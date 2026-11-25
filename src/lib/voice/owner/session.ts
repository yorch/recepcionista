/**
 * Entering owner mode, server-side only. Called by the initiation webhook and the incoming route AFTER the call row exists:
 * when the caller id equals the business's VERIFIED owner number the row becomes kind 'owner' and the call gets the private owner
 * prompt, first message and a short maximum duration. Owner calls are never blocked by the minute caps (only by that duration and the
 * daily session limit) and leave no customer-facing artifact (no transcript, summary, recording, briefing or gratitude trigger).
 */
import { prisma, setCallTrust, updateCall } from '@/lib/db';
import { logger } from '@/lib/log';
import { attestationLevel } from '@/lib/stir';
import { detectOwnerCaller } from './detect';
import { ownerCallMaxSeconds, ownerTrustOf, OWNER_SESSIONS_PER_DAY, type OwnerTrust } from './config';
import { ownerFirstMessage, ownerLimitMessage, ownerPrompt } from './prompt';
import { auditOwnerKb } from './apply';
import type { Business, Call } from '@/lib/types';

const log = logger('owner-callin');

export interface OwnerEntry {
  override: { agent: { first_message: string; prompt?: { prompt: string } }; conversation: { max_duration_seconds: number } };
  variables: { owner_mode: 'true' };
  limited: boolean;
}

/** Owner sessions in the last 24 h of ONE identity class (STIR-verified calls and unverified calls are counted separately). */
export async function ownerSessionsToday(businessId: string, exceptCallId: string, trust: OwnerTrust = 'unverified', now: Date = new Date()): Promise<number> {
  return prisma.call.count({
    where: {
      businessId, kind: 'owner', id: { not: exceptCallId }, startedAt: { gte: new Date(now.getTime() - 24 * 3600_000) },
      ...(trust === 'verified' ? { callerVerified: true } : { OR: [{ callerVerified: null }, { callerVerified: false }] }),
    },
  });
}

/**
 * Null = not an owner call (nothing changed: the caller is served as a customer). `planLapsed`: an inactive plan keeps the owner line
 * closed like every other service. A spoofed caller id lands here too: it grants a conversation only, never a change (sms.ts).
 */
export async function enterOwnerMode(
  business: Business, call: Call | null, callerId: string | null | undefined, opts: { planLapsed?: boolean; promptOverride?: boolean; stirStatus?: string | null } = {},
): Promise<OwnerEntry | null> {
  const who = detectOwnerCaller(business, callerId);
  if (!who.owner) {
    if (who.reason === 'owner_unverified' || who.reason === 'mismatch') log.debug('not_owner', { business: business.id, reason: who.reason });
    return null;
  }
  if (!call) { log.warn('no_call_row', { business: business.id }); return null; } // without a row the tools could not be gated
  if (opts.planLapsed) return null;
  // The carrier says the caller id FAILED validation: the owner number is being spoofed. Owner mode would grant cap-exempt minutes, burn
  // the real owner's daily sessions and trip the lockout; serve the call as an ordinary (stranger) call instead. A line that reports
  // no verdict at all is common and stays allowed (the SMS confirmation is the real control).
  if (attestationLevel(opts.stirStatus) === 'failed') {
    log.warn('owner_mode_refused_stir_failed', { business: business.id, call: call.id });
    await auditOwnerKb('refused', business.id, { actor_kind: 'system', via: 'voice' }, null, { call: call.id, why: 'stir_failed' }).catch(() => {});
    return null;
  }
  const max = ownerCallMaxSeconds();
  // Persist the verdict first: the tools read the identity class from the row (budgets are per class), and a webhook that carried the
  // verdict only to us would otherwise leave it unset.
  const trust: OwnerTrust = ownerTrustOf({ caller_verified: attestationLevel(opts.stirStatus) === 'A' ? true : (opts.stirStatus ? false : call.caller_verified ?? null) });
  if (opts.stirStatus) await setCallTrust(call.id, opts.stirStatus).catch((err) => log.warn('trust_store_failed', { call: call.id, err }));
  const sessions = await ownerSessionsToday(business.id, call.id, trust);
  const limited = sessions >= OWNER_SESSIONS_PER_DAY;
  // kind 'owner' first: from here on every customer-facing path ignores this row.
  await updateCall(call.id, { kind: 'owner', caller_phone: who.e164 });
  await auditOwnerKb('session', business.id, { actor_kind: 'system', via: 'voice' }, null, { call: call.id, limited, trust });
  if (limited) {
    log.warn('session_limit', { business: business.id, call: call.id });
    return { override: { agent: { first_message: ownerLimitMessage(business) }, conversation: { max_duration_seconds: 30 } }, variables: { owner_mode: 'true' }, limited: true };
  }
  return {
    override: {
      agent: { first_message: ownerFirstMessage(business), ...(opts.promptOverride === false ? {} : { prompt: { prompt: ownerPrompt(business) } }) },
      conversation: { max_duration_seconds: max },
    },
    variables: { owner_mode: 'true' },
    limited: false,
  };
}
