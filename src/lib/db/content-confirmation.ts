/**
 * Go-live confirmation of the template content. The owner confirms the services / prices / service area the template put in their knowledge base
 * before the business goes live. The confirmation stores a FINGERPRINT of that content (businesses.content_confirmed_hash) next to the time, so
 * no writer of services / pricing / service area has to remember to reset anything: a change makes the state `stale` by itself
 * (contentConfirmationState). The fingerprint covers services (incl. descriptions), FAQs, pricing notes and service area (see contentFingerprint).
 */
import { prisma } from './client';
import { getKnowledgeBase, toBusiness } from './index';
import { recordAudit } from './audit';
import { contentConfirmationState, contentFingerprintOf, type ContentConfirmation } from '@/lib/business-config';
import type { AuditActorKind, ID } from '@/lib/types';

export interface ContentConfirmationInfo { state: ContentConfirmation; confirmed_at: string | null; /** Fingerprint of the content as stored now: send it back as `expected_hash` when confirming. */ content_hash: string }

export async function getContentConfirmation(businessId: ID): Promise<ContentConfirmationInfo | null> {
  const row = await prisma.business.findUnique({ where: { id: businessId } });
  if (!row) return null;
  const b = toBusiness(row);
  const kb = await getKnowledgeBase(businessId);
  return { state: contentConfirmationState(b, kb), confirmed_at: b.content_confirmed_at ?? null, content_hash: contentFingerprintOf(b, kb) };
}

export type ConfirmContentResult = ContentConfirmationInfo | { changed: true; content_hash: string } | null;

/**
 * Confirm the content as it is right now (the owner clicked "this is right"). Audited. Null = no such business.
 * With `expected_hash` (the fingerprint of the content the owner SAW) the confirmation is refused (`{ changed: true }`) when the stored content is no longer
 * that: a staff member edited prices meanwhile, or the page was stale. Without it the current content is confirmed (API clients that just saved it).
 */
export async function confirmContent(
  businessId: ID, actor: { kind: AuditActorKind; user_id?: string | null; ip?: string | null }, now: Date = new Date(), opts: { expected_hash?: string | null } = {},
): Promise<ConfirmContentResult> {
  const row = await prisma.business.findUnique({ where: { id: businessId } });
  if (!row) return null;
  const kb = await getKnowledgeBase(businessId);
  const hash = contentFingerprintOf({ service_area: row.serviceArea }, kb);
  if (opts.expected_hash && opts.expected_hash !== hash) return { changed: true, content_hash: hash };
  await prisma.business.update({ where: { id: businessId }, data: { contentConfirmedAt: now, contentConfirmedHash: hash } });
  await recordAudit({ actor_kind: actor.kind, actor_user_id: actor.user_id ?? null, business_id: businessId, action: 'business.content_confirmed', target: `business:${businessId}`, ip: actor.ip ?? null, at: now });
  return { state: 'confirmed', confirmed_at: now.toISOString(), content_hash: hash };
}

/** Forget the confirmation (e.g. the owner switched the vertical template and must re-confirm). */
export async function clearContentConfirmation(businessId: ID): Promise<boolean> {
  const res = await prisma.business.updateMany({ where: { id: businessId }, data: { contentConfirmedAt: null, contentConfirmedHash: null } });
  return res.count === 1;
}
