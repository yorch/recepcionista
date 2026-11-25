/**
 * Go-live confirmation of the template content. The owner confirms the services / prices / service area the template put in their knowledge base
 * before the business goes live. The confirmation stores a FINGERPRINT of that content (businesses.content_confirmed_hash) next to the time, so
 * no writer of services / pricing / service area has to remember to reset anything: a change makes the state `stale` by itself
 * (contentConfirmationState). Editing FAQs or prose descriptions does not (see contentFingerprint).
 */
import { prisma } from './client';
import { getKnowledgeBase, toBusiness } from './index';
import { recordAudit } from './audit';
import { contentConfirmationState, contentFingerprint, type ContentConfirmation } from '@/lib/business-config';
import type { AuditActorKind, ID } from '@/lib/types';

export interface ContentConfirmationInfo { state: ContentConfirmation; confirmed_at: string | null }

export async function getContentConfirmation(businessId: ID): Promise<ContentConfirmationInfo | null> {
  const row = await prisma.business.findUnique({ where: { id: businessId } });
  if (!row) return null;
  const b = toBusiness(row);
  const kb = await getKnowledgeBase(businessId);
  return { state: contentConfirmationState(b, kb), confirmed_at: b.content_confirmed_at ?? null };
}

/** Confirm the content as it is right now (the owner clicked "this is right"). Audited. Null = no such business. */
export async function confirmContent(businessId: ID, actor: { kind: AuditActorKind; user_id?: string | null; ip?: string | null }, now: Date = new Date()): Promise<ContentConfirmationInfo | null> {
  const row = await prisma.business.findUnique({ where: { id: businessId } });
  if (!row) return null;
  const kb = await getKnowledgeBase(businessId);
  const hash = contentFingerprint({ services: kb?.services, pricing_notes: kb?.pricing_notes, service_area: row.serviceArea });
  await prisma.business.update({ where: { id: businessId }, data: { contentConfirmedAt: now, contentConfirmedHash: hash } });
  await recordAudit({ actor_kind: actor.kind, actor_user_id: actor.user_id ?? null, business_id: businessId, action: 'business.content_confirmed', target: `business:${businessId}`, ip: actor.ip ?? null, at: now });
  return { state: 'confirmed', confirmed_at: now.toISOString() };
}

/** Forget the confirmation (e.g. the owner switched the vertical template and must re-confirm). */
export async function clearContentConfirmation(businessId: ID): Promise<boolean> {
  const res = await prisma.business.updateMany({ where: { id: businessId }, data: { contentConfirmedAt: null, contentConfirmedHash: null } });
  return res.count === 1;
}
