import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { publishLegal } from '@/lib/admin/legal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST { reason }: publish the draft as the next version of the page. Audited as `legal.published`. Permission: legal.publish (owner). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string; locale: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'legal.publish', write: true, frozenBlocks: true, rate: { name: 'legal-write', max: 30 } });
  if (!g.ok) return g.response;
  try {
    const { slug, locale } = await params;
    const b = await readBody(req);
    return ok(await publishLegal({ slug, locale, reason: b.reason, actor: g.ctx.actor }));
  } catch (err) { return adminFail(err); }
}
