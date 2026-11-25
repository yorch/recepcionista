/**
 * Server-side go-live readiness: the pure checks of ./readiness plus the owner's confirmation of the template content (services, prices, service
 * area), compared by fingerprint (business-config.contentConfirmationState, which needs node:crypto, so this file must never reach a client bundle).
 * A business that is already live is not re-gated by the confirmation (the dashboard still shows `stale`).
 */
import { contentConfirmationState } from '@/lib/business-config';
import { readinessOf, type Readiness, type ReadinessKb } from './readiness';
import type { Business, KnowledgeBase } from '@/lib/types';

export function contentStateOf(business: Pick<Business, 'content_confirmed_at' | 'content_confirmed_hash' | 'service_area'>, kb: (Pick<KnowledgeBase, 'services' | 'pricing_notes'> & Partial<Pick<KnowledgeBase, 'faqs'>>) | null | undefined) {
  return contentConfirmationState(business, kb);
}

/** The fingerprint of the content as stored right now (sent back with the owner's confirmation, so what they saw is what they confirm). */
export { contentFingerprintOf as contentHashOf } from '@/lib/business-config';

export function readinessForGoLive(
  kb: (ReadinessKb & Partial<Pick<KnowledgeBase, 'pricing_notes'>>) | null | undefined,
  business: Pick<Business, 'hours' | 'service_area' | 'owner_name' | 'vertical' | 'status' | 'content_confirmed_at' | 'content_confirmed_hash'>,
  lang: 'en' | 'es' = 'en',
): Readiness {
  const state = business.status === 'live' ? undefined : contentConfirmationState(business, kb as (Pick<KnowledgeBase, 'services' | 'pricing_notes'> & Partial<Pick<KnowledgeBase, 'faqs'>>) | null | undefined);
  return readinessOf(kb, business, lang, state);
}
