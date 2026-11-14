import { ok, fail } from '@/lib/http';
import { getBusiness, updateBusiness, getKnowledgeBase, upsertKnowledgeBase } from '@/lib/db';
import { extractFromUrl, templateResult } from '@/lib/extraction';
import { generateKnowledgeBase } from '@/lib/kb';
import { provisionNumber } from '@/lib/providers/twilio';
import type { ApiResult, Business, KnowledgeBase } from '@/lib/types';

export interface ProvisionResult {
  business: Business;
  knowledge_base: KnowledgeBase;
  phone: string;
  mock: boolean;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<ProvisionResult>> | ReturnType<typeof fail>> {
  try {
    const { id } = await params;
    const business = getBusiness(id);
    if (!business) return fail('business not found', 404);

    // 1. Knowledge base: reuse if present, otherwise extract (or template).
    let kb = getKnowledgeBase(id);
    if (!kb) {
      let extraction;
      try {
        extraction = business.url ? await extractFromUrl(business.url) : templateResult(business.name);
      } catch {
        extraction = templateResult(business.name);
      }
      const generated = generateKnowledgeBase(extraction, business);
      kb = upsertKnowledgeBase(id, generated);
    }

    // 2. Provision the phone number and go live.
    const { phone, mock } = await provisionNumber('305');
    const updated = updateBusiness(id, { phone, status: 'live' });
    if (!updated) return fail('business not found', 404);

    return ok<ProvisionResult>({ business: updated, knowledge_base: kb, phone, mock });
  } catch (err) {
    return fail(err, 500);
  }
}
