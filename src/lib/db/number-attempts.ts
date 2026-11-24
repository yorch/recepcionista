/**
 * Bookkeeping for phone-number purchases (F1 of docs/review/08). The Twilio account is shared by EVERY tenant, so "the
 * number is listed on the account" proves nothing about who bought it. Provisioning therefore records, BEFORE it buys,
 * which candidate it is about to buy under a per-attempt id (`processed_events`), claims the candidate so two tenants
 * cannot buy the same one at once, and only ever adopts a number that attempt tried to buy.
 */
import { prisma } from './client';
import { claimEvent, completeEvent, releaseEvent } from './events';
import type { NumberAttemptStore } from '@/lib/providers/twilio';

export const NUMBER_CANDIDATE_SOURCE = 'number-candidate';
export const NUMBER_ATTEMPT_SOURCE = 'number-attempt';
/** How long an in-flight candidate stays reserved for the attempt that claimed it. */
export const CANDIDATE_LEASE_MS = 15 * 60_000;

/** Does ANY business row (any status) hold this number? `exceptBusinessId` ignores the caller's own row. */
export async function numberHeldByBusiness(e164: string, exceptBusinessId?: string | null): Promise<boolean> {
  const key = e164.replace(/\D/g, '').slice(-10);
  const n = await prisma.business.count({
    where: {
      ...(exceptBusinessId ? { id: { not: exceptBusinessId } } : {}),
      OR: [{ phone: e164 }, { phoneE164: e164 }, ...(key.length === 10 ? [{ phoneKey: key }] : [])],
    },
  });
  return n > 0;
}

export function createNumberAttemptStore(attemptId: string): NumberAttemptStore {
  const attemptRow = (e164: string) => ({ source: NUMBER_ATTEMPT_SOURCE, id: `${attemptId}:${e164}` });
  return {
    id: attemptId,
    isHeld: (e164) => numberHeldByBusiness(e164),
    claim: (e164) => claimEvent(NUMBER_CANDIDATE_SOURCE, e164, CANDIDATE_LEASE_MS),
    async record(e164) {
      await prisma.processedEvent.create({ data: { ...attemptRow(e164), status: 'processing' } });
    },
    async attempted(e164) {
      const row = await prisma.processedEvent.findUnique({ where: { source_id: attemptRow(e164) }, select: { id: true } });
      return row !== null;
    },
    async finish(e164, outcome) {
      if (outcome === 'bought') await completeEvent(NUMBER_CANDIDATE_SOURCE, e164);
      else if (outcome === 'refused') await releaseEvent(NUMBER_CANDIDATE_SOURCE, e164);
      await completeEvent(NUMBER_ATTEMPT_SOURCE, `${attemptId}:${e164}`);
    },
  };
}
