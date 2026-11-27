import { ok, fail } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { discardLegalDraft, getLegalVersion, isLegalLocale, isLegalSlug, listLegalPages, saveLegalDraft } from '@/lib/admin/legal';
import type { StoreActor } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ slug: string; locale: string }> };

/** GET ?version=N: the markdown of a version (default: the draft, else the published one). Permission: legal.read. */
export async function GET(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'legal.read', rate: { name: 'legal', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const { slug, locale } = await params;
    if (!isLegalSlug(slug) || !isLegalLocale(locale)) return fail('unknown page', 404);
    const page = (await listLegalPages()).find((p) => p.slug === slug && p.locale === locale)!;
    const q = new URL(req.url).searchParams.get('version');
    const version = q ? Number(q) : page.draft_version ?? page.published_version;
    if (!version || !Number.isInteger(version)) return ok({ page, version: null });
    const v = await getLegalVersion(slug, locale, version);
    return v ? ok({ page, version: v }) : fail('version not found', 404);
  } catch (err) { return adminFail(err); }
}

/** PUT { body: markdown (<= 200000 chars), note? }: create or update THE draft. Permission: legal.write. */
export async function PUT(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'legal.write', write: true, frozenBlocks: true, rate: { name: 'legal-write', max: 30 } });
  if (!g.ok) return g.response;
  try {
    const { slug, locale } = await params;
    const b = await readBody(req, 1_000_000);
    return ok(await saveLegalDraft({ slug, locale, body: b.body, note: b.note, actor: g.ctx.actor as StoreActor }));
  } catch (err) { return adminFail(err); }
}

/** DELETE: discard the draft (published versions are kept forever). Permission: legal.write. */
export async function DELETE(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'legal.write', write: true, frozenBlocks: true, rate: { name: 'legal-write', max: 30 } });
  if (!g.ok) return g.response;
  try { const { slug, locale } = await params; return ok({ discarded: await discardLegalDraft({ slug, locale, actor: g.ctx.actor }) }); } catch (err) { return adminFail(err); }
}
