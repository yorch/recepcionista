import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { listLegalPages, LEGAL_LOCALES, LEGAL_SLUGS, MAX_LEGAL_BODY } from '@/lib/admin/legal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The six legal pages (terms | privacy | sms_terms x en | es) with published version, draft version and version list (no bodies). Permission: legal.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'legal.read', rate: { name: 'legal', max: 60 } });
  if (!g.ok) return g.response;
  try { return ok({ pages: await listLegalPages(), slugs: LEGAL_SLUGS, locales: LEGAL_LOCALES, max_body_chars: MAX_LEGAL_BODY }); } catch (err) { return adminFail(err); }
}
