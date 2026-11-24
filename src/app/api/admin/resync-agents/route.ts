import { ok, fail, readJson } from '@/lib/http';
import { authenticate } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { prisma, getBusiness, getKnowledgeBase, recordAudit } from '@/lib/db';
import { expectedToolNames, hasElevenLabs, resetInitiationCache, syncAgent } from '@/lib/voice/elevenlabs';
import { finishCreatedAgent } from '@/lib/voice/agent-created';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('admin/resync-agents');
export const RESYNC_MAX_BATCH = 25;
export const RESYNC_DEFAULT_BATCH = 10;

export interface ResyncItem { business_id: string; agent_id: string; outcome: 'would_sync' | 'synced' | 'created' | 'mock' | 'failed' | 'skipped'; detail?: string }
export interface ResyncResult {
  dry_run: boolean;
  configured: boolean;
  tools: string[];
  /** Business ids considered in this batch (ordered by id). */
  items: ResyncItem[];
  /** Pass back as `cursor` to continue; null when the last batch was processed. */
  next_cursor: string | null;
}

/**
 * Admin-only: re-register the workspace tools and re-push the full agent config (prompt, tool ids, language detection, voice, dynamic variables,
 * initiation webhook and override flags) to the ElevenLabs agents of existing businesses, e.g. after a deploy that added or changed a tool.
 * `{ dry_run?: true (default), business_ids?: string[], limit?: 1..25 (default 10), cursor?: string }`.
 *  - DRY RUN (the default) makes NO provider call and writes nothing: it lists the businesses (with an agent) a real run would sync and the tools it would register.
 *  - A real run (`"dry_run": false`) syncs ONE batch through the same `syncAgent` as provisioning, one business at a time, and answers `next_cursor`
 *    for the next batch (loop until it is null). Re-running is safe (idempotent).
 *  - Rate limited (6 requests/minute per client); audited as `admin.resync_agents` (counts + business ids, never prompts or keys).
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'admin/resync-agents', 6);
  if (limited) return limited;
  try {
    const raw = await readJson<unknown>(req).catch(() => ({}));
    if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) return fail('invalid body', 422);
    const body = (raw ?? {}) as Record<string, unknown>; // an empty body is a dry run of the first batch
    for (const k of Object.keys(body)) if (!['dry_run', 'business_ids', 'limit', 'cursor'].includes(k)) return fail(`unknown field "${k}"`, 422);
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return fail('dry_run must be true or false', 422);
    const dryRun = body.dry_run !== false;
    let limit = RESYNC_DEFAULT_BATCH;
    if (body.limit !== undefined) {
      if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > RESYNC_MAX_BATCH) return fail(`limit must be an integer between 1 and ${RESYNC_MAX_BATCH}`, 422);
      limit = body.limit;
    }
    if (body.cursor !== undefined && (typeof body.cursor !== 'string' || !body.cursor || body.cursor.length > 100)) return fail('cursor must be a business id', 422);
    let ids: string[] | null = null;
    if (body.business_ids !== undefined) {
      if (!Array.isArray(body.business_ids) || body.business_ids.length === 0 || body.business_ids.length > RESYNC_MAX_BATCH || body.business_ids.some((x) => typeof x !== 'string' || !x || x.length > 100)) {
        return fail(`business_ids must be 1-${RESYNC_MAX_BATCH} business ids`, 422);
      }
      ids = [...new Set(body.business_ids as string[])];
    }

    const rows = await prisma.business.findMany({
      where: { agentId: { not: null }, ...(ids ? { id: { in: ids } } : {}), ...(typeof body.cursor === 'string' ? { id: { gt: body.cursor, ...(ids ? { in: ids } : {}) } } : {}) },
      orderBy: { id: 'asc' }, take: limit + 1, select: { id: true, agentId: true },
    });
    const batch = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? batch[batch.length - 1].id : null;
    const configured = hasElevenLabs();
    const items: ResyncItem[] = [];

    if (dryRun) {
      for (const r of batch) items.push({ business_id: r.id, agent_id: r.agentId as string, outcome: 'would_sync' });
    } else if (!configured) {
      return fail('ELEVENLABS_API_KEY is not set: there is no provider to sync', 503);
    } else {
      resetInitiationCache(); // write the webhook + override flags again, not "already done by this process"
      for (const r of batch) {
        try {
          const business = await getBusiness(r.id);
          if (!business) { items.push({ business_id: r.id, agent_id: r.agentId as string, outcome: 'skipped', detail: 'business disappeared' }); continue; }
          const res = await syncAgent({ business, kb: await getKnowledgeBase(r.id), agent_id: r.agentId as string });
          items.push({
            business_id: r.id, agent_id: res.agent_id,
            outcome: res.mock ? 'mock' : res.created ? 'created' : 'synced', ...(res.error ? { detail: res.error.slice(0, 120) } : {}),
          });
          if (res.mock || res.error) items[items.length - 1].outcome = 'failed';
          else if (res.created) {
            // The old agent was gone at the provider (404), so a NEW one was made. It needs what provisioning gives every agent: the phone
            // number binding and the post-call webhook (summaries, transcripts, metering). Flagged for the operator: check the old agent is gone.
            const notes = await finishCreatedAgent(res.agent_id, r.id);
            items[items.length - 1].detail = `NEW agent created (the previous one was not found at the provider)${notes.length ? `; ${notes.join('; ')}: finish in the runbook` : ''}`;
          }
        } catch (err) {
          log.warn('resync.failed', { business: r.id, err });
          items.push({ business_id: r.id, agent_id: r.agentId as string, outcome: 'failed', detail: (err as Error).message.slice(0, 120) });
        }
      }
    }

    const user = auth.principal.kind === 'admin' ? auth.principal.user : null;
    await recordAudit({
      actor_kind: user ? 'user' : 'admin_token', actor_user_id: user?.id ?? null, action: 'admin.resync_agents', target: 'agents',
      meta: {
        dry_run: dryRun, batch: batch.length, synced: items.filter((i) => i.outcome === 'synced' || i.outcome === 'created').length,
        created: items.filter((i) => i.outcome === 'created').length, failed: items.filter((i) => i.outcome === 'failed').length, business_ids: batch.map((b) => b.id), has_more: nextCursor !== null,
      },
    });
    return ok<ResyncResult>({ dry_run: dryRun, configured, tools: expectedToolNames(), items, next_cursor: nextCursor });
  } catch (err) {
    return fail(err, 500);
  }
}
