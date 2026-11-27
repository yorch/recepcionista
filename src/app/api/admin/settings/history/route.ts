import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, int } from '@/lib/admin/guard';
import { listChangeSets } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET ?limit=1..100&before=<version>&key=<setting key>: change sets newest first (who, when, tier, reason, keys). Permission: settings.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'settings-history', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const q = new URL(req.url).searchParams;
    return ok(await listChangeSets({ limit: int(q.get('limit'), 25, 1, 100), before: q.get('before') ?? undefined, key: q.get('key') ?? undefined }));
  } catch (err) { return adminFail(err); }
}
