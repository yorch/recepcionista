/**
 * Durable retry for "the stored prompt / the live voice agent no longer matches the business" (a failed provider sync after a vertical
 * change, for example). Without it a transient 5xx left the live agent triaging with the OLD trade's emergency rules until somebody
 * happened to re-provision.
 *
 * `markAgentDirty` leaves a marker (`processed_events`, source `agent-dirty:<failed attempts>`, id = business id, status 'processing';
 * `claimed_at` = when to try next; the status column only allows processing|done, so the attempt count lives in the source). `drainDirtyAgents` (run by the `reconcile` job every tick) re-builds the system prompt from the fresh
 * business + knowledge base and pushes it (resyncAfterKbChange), under a per-business lease. A success removes the marker; a failure backs
 * off exponentially (2 min, doubling, capped at 1 h) and after MAX_ATTEMPTS the job gives up loudly (log.error + audit row
 * `agent.resync_gave_up`) because somebody has to look.
 */
import { getBusiness, getKnowledgeBase, prisma, recordAudit, upsertKnowledgeBase, withLease } from '@/lib/db';
import { buildCallScript } from '@/lib/kb';
import { VERTICALS } from '@/lib/types';
import { resyncAfterKbChange } from '@/lib/voice/owner/apply';
import { logger } from '@/lib/log';

const log = logger('voice/agent-resync');
export const AGENT_DIRTY_SOURCE = 'agent-dirty';
export const dirtySource = (failures: number): string => `${AGENT_DIRTY_SOURCE}:${failures}`;
export const AGENT_RESYNC_MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
export const agentResyncBackoffMs = (failures: number): number => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
const failuresOf = (source: string): number => Number(/^agent-dirty:(\d+)$/.exec(source)?.[1] ?? 0);

/** Remember that this business's agent must be re-synced. Idempotent; never throws. */
export async function markAgentDirty(businessId: string, now: Date = new Date()): Promise<void> {
  try {
    await prisma.processedEvent.deleteMany({ where: { source: { startsWith: `${AGENT_DIRTY_SOURCE}:` }, id: businessId } });
    await prisma.processedEvent.create({ data: { source: dirtySource(0), id: businessId, status: 'processing', claimedAt: now, createdAt: now } });
  } catch (err) { log.error('mark_failed', { business: businessId, err }); }
}

/**
 * Bring the GENERATED call script in line with the business's current vertical. A vertical change rebuilds it inline, but when that rebuild
 * could not write the knowledge base row the script stayed the previous trade's. The retry cannot know the previous vertical, so it recognises
 * a generated script by content: empty, or identical to what ANY vertical generates for these services. An owner-edited script matches none of
 * them and is never touched. Idempotent; returns whether the script was rewritten. Throws on a database error (the drain then keeps the marker).
 */
export async function rebuildGeneratedCallScript(businessId: string): Promise<boolean> {
  const business = await getBusiness(businessId);
  const kb = await getKnowledgeBase(businessId);
  if (!business || !kb) return false;
  const wanted = buildCallScript({ services: kb.services }, business);
  if (kb.call_script === wanted) return false;
  const generated = !kb.call_script.trim() || VERTICALS.some((v) => kb.call_script === buildCallScript({ services: kb.services }, { vertical: v }));
  if (!generated) return false;
  await upsertKnowledgeBase(businessId, { call_script: wanted });
  return true;
}

export interface DrainAgentsResult { considered: number; synced: number; failed: number; gave_up: number }

export async function drainDirtyAgents(opts: { now?: Date; limit?: number; dryRun?: boolean } = {}): Promise<DrainAgentsResult> {
  const now = opts.now ?? new Date();
  const out: DrainAgentsResult = { considered: 0, synced: 0, failed: 0, gave_up: 0 };
  try {
    const rows = await prisma.processedEvent.findMany({
      where: { source: { startsWith: `${AGENT_DIRTY_SOURCE}:` }, status: 'processing', claimedAt: { lte: now } }, orderBy: { claimedAt: 'asc' }, take: Math.min(Math.max(opts.limit ?? 10, 1), 50),
    });
    out.considered = rows.length;
    if (opts.dryRun) return out;
    for (const row of rows) {
      const lease = await withLease(`agent-resync:${row.id}`, 2 * 60_000, async () => {
        // The call script first (a failed rebuild after a vertical change leaves the previous trade's), then the prompt + the live agent.
        try { await rebuildGeneratedCallScript(row.id); } catch (err) { log.warn('call_script_rebuild_failed', { business: row.id, err }); return { prompt: false, agent: 'failed' as const }; }
        const r = await resyncAfterKbChange(row.id);
        return r;
      });
      if (!lease.acquired) continue;
      const r = lease.value;
      if (r.agent === 'synced' || r.agent === 'skipped') {
        await prisma.processedEvent.deleteMany({ where: { source: row.source, id: row.id } });
        out.synced++;
        continue;
      }
      const failures = failuresOf(row.source) + 1;
      if (failures >= AGENT_RESYNC_MAX_ATTEMPTS) {
        out.gave_up++;
        await prisma.processedEvent.updateMany({ where: { source: row.source, id: row.id }, data: { status: 'done' } }); // parked: no longer 'processing'
        log.error('resync_gave_up', { business: row.id, attempts: failures, action: 'the live voice agent could not be synced; use POST /api/admin/resync-agents (docs/runbook.md)' });
        await recordAudit({ actor_kind: 'system', business_id: row.id, action: 'agent.resync_gave_up', target: `business:${row.id}`, meta: { attempts: failures } });
        continue;
      }
      out.failed++;
      await prisma.processedEvent.updateMany({
        where: { source: row.source, id: row.id }, data: { source: dirtySource(failures), claimedAt: new Date(now.getTime() + agentResyncBackoffMs(failures)) },
      });
    }
  } catch (err) { log.error('drain_failed', { err }); }
  return out;
}
