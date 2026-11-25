import { ok, fail, readJson } from '@/lib/http';
import { authenticate } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { prisma, recordAudit } from '@/lib/db';
import { configureNumberWebhooks, numberWebhooks, type NumberWebhookOutcome } from '@/lib/providers/twilio';
import { toE164 } from '@/lib/phone';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('admin/repair-numbers');
export const REPAIR_MAX_BATCH = 25;
export const REPAIR_DEFAULT_BATCH = 10;

export interface RepairItem { business_id: string; phone: string; outcome: NumberWebhookOutcome; changed?: string[]; detail?: string }
export interface RepairResult {
  dry_run: boolean;
  /** The webhook addresses the numbers must carry (null: no public base URL is configured, nothing can be repaired). */
  webhooks: ReturnType<typeof numberWebhooks>;
  items: RepairItem[];
  next_cursor: string | null;
}

/**
 * Admin-only, IDEMPOTENT repair of the Twilio webhooks of numbers that were bought before they were configured at purchase
 * (SmsUrl = APP_URL/api/sms/inbound; plus VoiceUrl = APP_URL/api/voice/incoming ONLY on the 'webhook' line: a native ElevenLabs line owns its
 * Voice URL and is never touched). `{ dry_run?: true (default), business_ids?: string[], limit?: 1..25 (default 10), cursor?: string }`.
 *  - DRY RUN (the default) reads each number from Twilio and reports `would_update` + the fields that differ; it changes nothing.
 *  - `"dry_run": false` updates only the differing fields (a number that is already right is `ok`); loop on `next_cursor` until null.
 *  - Never touches TWILIO_PHONE_NUMBER (the platform sender) or mock-pool numbers. Audited as `admin.repair_numbers` (counts + business ids).
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'admin/repair-numbers', 6);
  if (limited) return limited;
  try {
    const raw = await readJson<unknown>(req).catch(() => ({}));
    if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) return fail('invalid body', 422);
    const body = (raw ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(body)) if (!['dry_run', 'business_ids', 'limit', 'cursor'].includes(k)) return fail(`unknown field "${k}"`, 422);
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return fail('dry_run must be true or false', 422);
    const dryRun = body.dry_run !== false;
    let limit = REPAIR_DEFAULT_BATCH;
    if (body.limit !== undefined) {
      if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > REPAIR_MAX_BATCH) return fail(`limit must be an integer between 1 and ${REPAIR_MAX_BATCH}`, 422);
      limit = body.limit;
    }
    if (body.cursor !== undefined && (typeof body.cursor !== 'string' || !body.cursor || body.cursor.length > 100)) return fail('cursor must be a business id', 422);
    let ids: string[] | null = null;
    if (body.business_ids !== undefined) {
      if (!Array.isArray(body.business_ids) || body.business_ids.length === 0 || body.business_ids.length > REPAIR_MAX_BATCH || body.business_ids.some((x) => typeof x !== 'string' || !x || x.length > 100)) {
        return fail(`business_ids must be 1-${REPAIR_MAX_BATCH} business ids`, 422);
      }
      ids = [...new Set(body.business_ids as string[])];
    }
    const hooks = numberWebhooks();
    if (!hooks) return fail('no public base URL is configured (PUBLIC_BASE_URL or APP_URL): the webhook addresses are unknown', 503);
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) return fail('Twilio is not configured: there are no numbers to repair', 503);

    const rows = await prisma.business.findMany({
      where: { phone: { not: null }, ...(ids ? { id: { in: ids } } : {}), ...(typeof body.cursor === 'string' ? { id: { gt: body.cursor, ...(ids ? { in: ids } : {}) } } : {}) },
      orderBy: { id: 'asc' }, take: limit + 1, select: { id: true, phone: true },
    });
    const batch = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? batch[batch.length - 1].id : null;
    const items: RepairItem[] = [];
    for (const r of batch) {
      const phone = toE164(r.phone) ?? (r.phone as string);
      const res = await configureNumberWebhooks(phone, { dryRun });
      items.push({ business_id: r.id, phone, outcome: res.outcome, ...(res.changed ? { changed: res.changed } : {}), ...(res.detail ? { detail: res.detail } : {}) });
      if (res.outcome === 'failed') log.warn('repair.failed', { business: r.id, detail: res.detail });
    }
    const user = auth.principal.kind === 'admin' ? auth.principal.user : null;
    await recordAudit({
      actor_kind: user ? 'user' : 'admin_token', actor_user_id: user?.id ?? null, action: 'admin.repair_numbers', target: 'numbers',
      meta: {
        dry_run: dryRun, batch: batch.length, updated: items.filter((i) => i.outcome === 'updated').length,
        would_update: items.filter((i) => i.outcome === 'would_update').length, failed: items.filter((i) => i.outcome === 'failed').length,
        business_ids: batch.map((b) => b.id), has_more: nextCursor !== null,
      },
    });
    return ok<RepairResult>({ dry_run: dryRun, webhooks: hooks, items, next_cursor: nextCursor });
  } catch (err) {
    return fail(err, 500);
  }
}
