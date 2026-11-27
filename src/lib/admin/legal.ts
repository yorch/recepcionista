/**
 * Legal pages (terms | privacy | sms_terms, per locale) with a draft / publish / version history (D14). Node runtime only.
 * The body is MARKDOWN stored as text (<= 200000 characters, also a CHECK); it is never rendered here. Whatever renders it later must treat it as untrusted:
 * escape HTML, allow only a safe markdown subset and http(s)/mailto links (a legal page is editable by an admin, i.e. a hijacked admin could plant script).
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { requireConfirmPhrase } from './confirm';
import { roleCan } from './permissions';
import { assertSettingsWritable, MAX_REASON, MIN_REASON, SettingsError, type StoreActor } from './settings-store';

export const LEGAL_SLUGS = ['terms', 'privacy', 'sms_terms'] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];
export const LEGAL_LOCALES = ['en', 'es'] as const;
export type LegalLocale = (typeof LEGAL_LOCALES)[number];
export const MAX_LEGAL_BODY = 200_000;

export const isLegalSlug = (v: unknown): v is LegalSlug => typeof v === 'string' && (LEGAL_SLUGS as readonly string[]).includes(v);
export const isLegalLocale = (v: unknown): v is LegalLocale => typeof v === 'string' && (LEGAL_LOCALES as readonly string[]).includes(v);

export interface LegalVersionView {
  version: number; draft: boolean; note: string | null; created_by: string | null; created_at: string; published_at: string | null; published_by: string | null; chars: number;
  /** sha256 (hex) of the body: a publication names the exact draft (version + hash) that was reviewed. */
  hash: string;
  /** Only when asked for (the list omits bodies). */
  body?: string;
}
export interface LegalPageView { slug: LegalSlug; locale: LegalLocale; published_version: number | null; draft_version: number | null; versions: LegalVersionView[] }

/** Content hash a publication must carry. */
export const legalHash = (body: string): string => crypto.createHash('sha256').update(body, 'utf8').digest('hex');

const vv = (r: { version: number; draft: boolean; note: string | null; createdBy: string | null; createdAt: Date; publishedAt: Date | null; publishedBy: string | null; body: string }, withBody: boolean): LegalVersionView => ({
  version: r.version, draft: r.draft, note: r.note, created_by: r.createdBy, created_at: r.createdAt.toISOString(), published_at: r.publishedAt?.toISOString() ?? null, published_by: r.publishedBy,
  chars: r.body.length, hash: legalHash(r.body), ...(withBody ? { body: r.body } : {}),
});

const need = (a: StoreActor, perm: 'legal.write' | 'legal.publish') => { if (a.role !== 'system' && !roleCan(a.role, perm)) throw new SettingsError(403, 'forbidden', `not allowed to ${perm === 'legal.write' ? 'edit' : 'publish'} legal pages`); };

/** All six pages (3 slugs x 2 locales) with their versions (no bodies). */
export async function listLegalPages(): Promise<LegalPageView[]> {
  const [pages, versions] = await Promise.all([prisma.legalPage.findMany(), prisma.legalPageVersion.findMany({ orderBy: [{ version: 'desc' }] })]);
  const out: LegalPageView[] = [];
  for (const slug of LEGAL_SLUGS) for (const locale of LEGAL_LOCALES) {
    const page = pages.find((p) => p.slug === slug && p.locale === locale);
    const vs = versions.filter((v) => v.slug === slug && v.locale === locale);
    out.push({ slug, locale, published_version: page?.publishedVersion ?? null, draft_version: vs.find((v) => v.draft)?.version ?? null, versions: vs.map((v) => vv(v, false)) });
  }
  return out;
}

export async function getLegalVersion(slug: LegalSlug, locale: LegalLocale, version: number): Promise<LegalVersionView | null> {
  const r = await prisma.legalPageVersion.findUnique({ where: { slug_locale_version: { slug, locale, version } } });
  return r ? vv(r, true) : null;
}

/** The published text of a page (falls back to English when the locale has none), or null. For the public pages later. */
export async function getPublishedLegal(slug: LegalSlug, locale: LegalLocale): Promise<{ locale: LegalLocale; version: number; body: string; published_at: string } | null> {
  for (const l of locale === 'en' ? ['en' as const] : [locale, 'en' as const]) {
    const page = await prisma.legalPage.findUnique({ where: { slug_locale: { slug, locale: l } } });
    if (!page?.publishedVersion) continue;
    const v = await prisma.legalPageVersion.findUnique({ where: { slug_locale_version: { slug, locale: l, version: page.publishedVersion } } });
    if (v?.publishedAt) return { locale: l, version: v.version, body: v.body, published_at: v.publishedAt.toISOString() };
  }
  return null;
}

/** Create or update THE draft of a page (one draft at a time). */
export async function saveLegalDraft(opts: { slug: unknown; locale: unknown; body: unknown; note?: unknown; actor: StoreActor }): Promise<LegalVersionView> {
  need(opts.actor, 'legal.write');
  if (!isLegalSlug(opts.slug)) throw new SettingsError(422, 'invalid_slug', `slug must be one of ${LEGAL_SLUGS.join(', ')}`);
  if (!isLegalLocale(opts.locale)) throw new SettingsError(422, 'invalid_locale', `locale must be one of ${LEGAL_LOCALES.join(', ')}`);
  if (typeof opts.body !== 'string' || opts.body.trim().length === 0) throw new SettingsError(422, 'invalid_body', 'body is required');
  if (opts.body.length > MAX_LEGAL_BODY) throw new SettingsError(422, 'body_too_large', `at most ${MAX_LEGAL_BODY} characters`);
  if (opts.body.includes('\u0000')) throw new SettingsError(422, 'invalid_body', 'body contains a NUL character');
  const note = typeof opts.note === 'string' && opts.note.trim() ? opts.note.trim().slice(0, 200) : null;
  await assertSettingsWritable();
  const { slug, locale, body } = { slug: opts.slug, locale: opts.locale, body: opts.body };
  const row = await prisma.$transaction(async (tx) => {
    await tx.legalPage.upsert({ where: { slug_locale: { slug, locale } }, create: { slug, locale }, update: {} });
    await tx.$queryRaw`SELECT 1 FROM legal_pages WHERE slug = ${slug} AND locale = ${locale} FOR UPDATE`; // one draft writer at a time
    const draft = await tx.legalPageVersion.findFirst({ where: { slug, locale, draft: true } });
    let saved;
    if (draft) saved = await tx.legalPageVersion.update({ where: { id: draft.id }, data: { body, note, createdBy: opts.actor.user_id } });
    else {
      const last = await tx.legalPageVersion.aggregate({ where: { slug, locale }, _max: { version: true } });
      saved = await tx.legalPageVersion.create({ data: { id: crypto.randomUUID(), slug, locale, version: (last._max.version ?? 0) + 1, body, note, draft: true, createdBy: opts.actor.user_id } });
    }
    await tx.auditEvent.create({ data: auditRowData({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: 'legal.draft_saved', target: `legal:${slug}:${locale}`, ip: opts.actor.ip, meta: { slug, locale, version: saved.version, chars: body.length, role: opts.actor.role }, meta_trusted: true }) });
    return saved;
  });
  return vv(row, true);
}

/** Publish the current draft: it is frozen as a numbered version and becomes the page's published version. */
export async function publishLegal(opts: { slug: unknown; locale: unknown; reason: unknown; confirm: unknown; version: unknown; hash: unknown; actor: StoreActor }): Promise<LegalVersionView> {
  need(opts.actor, 'legal.publish');
  if (!isLegalSlug(opts.slug)) throw new SettingsError(422, 'invalid_slug', `slug must be one of ${LEGAL_SLUGS.join(', ')}`);
  if (!isLegalLocale(opts.locale)) throw new SettingsError(422, 'invalid_locale', `locale must be one of ${LEGAL_LOCALES.join(', ')}`);
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw new SettingsError(422, 'reason_required', `a reason of ${MIN_REASON} to ${MAX_REASON} characters is required`);
  if (opts.actor.role !== 'system') requireConfirmPhrase(opts.confirm, [`publish ${opts.slug}/${opts.locale}`]); // the console asks for it; so does the server
  // The publication names the draft that was REVIEWED (version + content hash): a draft edited by someone else after the review is refused, never silently published.
  if (!Number.isInteger(opts.version) || typeof opts.hash !== 'string' || !/^[0-9a-f]{64}$/.test(opts.hash)) throw new SettingsError(422, 'review_required', 'publish needs the version and content hash of the draft that was reviewed');
  await assertSettingsWritable();
  const { slug, locale } = { slug: opts.slug, locale: opts.locale };
  const row = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM legal_pages WHERE slug = ${slug} AND locale = ${locale} FOR UPDATE`;
    const draft = await tx.legalPageVersion.findFirst({ where: { slug, locale, draft: true } });
    if (!draft) throw new SettingsError(409, 'no_draft', 'there is no draft to publish');
    if (draft.version !== opts.version || legalHash(draft.body) !== opts.hash) throw new SettingsError(409, 'draft_changed', 'the draft changed after you reviewed it: reload it, review it again and publish that version');
    const now = new Date();
    const pub = await tx.legalPageVersion.update({ where: { id: draft.id }, data: { draft: false, publishedAt: now, publishedBy: opts.actor.user_id } });
    await tx.legalPage.update({ where: { slug_locale: { slug, locale } }, data: { publishedVersion: pub.version, updatedAt: now } });
    await tx.auditEvent.create({ data: auditRowData({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: 'legal.published', target: `legal:${slug}:${locale}`, ip: opts.actor.ip, meta: { slug, locale, version: pub.version, reason, role: opts.actor.role }, meta_trusted: true }) });
    return pub;
  });
  return vv(row, false);
}

/** Discard the draft (published versions are never deleted). */
export async function discardLegalDraft(opts: { slug: unknown; locale: unknown; actor: StoreActor }): Promise<boolean> {
  need(opts.actor, 'legal.write');
  if (!isLegalSlug(opts.slug) || !isLegalLocale(opts.locale)) throw new SettingsError(422, 'invalid_slug', 'invalid slug or locale');
  await assertSettingsWritable();
  const res = await prisma.legalPageVersion.deleteMany({ where: { slug: opts.slug, locale: opts.locale, draft: true } });
  if (res.count > 0) await prisma.auditEvent.create({ data: auditRowData({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: 'legal.draft_discarded', target: `legal:${opts.slug}:${opts.locale}`, ip: opts.actor.ip, meta: { role: opts.actor.role }, meta_trusted: true }) });
  return res.count > 0;
}
