import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { publishLegal } from '@/lib/admin/legal';
import { resetLegalLinksCache } from '@/lib/legal-links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST { reason }: publish the draft as the next version of the page. Audited as `legal.published`. Permission: legal.publish (owner). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string; locale: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'legal.publish', write: true, frozenBlocks: true, rate: { name: 'legal-write', max: 30 } });
  if (!g.ok) return g.response;
  try {
    const { slug, locale } = await params;
    const b = await readBody(req);
    const published = await publishLegal({ slug, locale, reason: b.reason, actor: g.ctx.actor });
    resetLegalLinksCache(); // the footers of THIS instance link the new page at once (others within the 60 s cache)
    return ok(published);
  } catch (err) { return adminFail(err); }
}
