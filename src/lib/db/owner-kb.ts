/**
 * Owner-driven knowledge-base changes (the owner phones in, texts, or uses the dashboard): propose -> apply -> (revert).
 *
 * - `proposeKbChange` stores a validated patch; nothing touches the knowledge base yet.
 * - `applyKbChange` claims the proposal and writes the knowledge base in ONE transaction, capturing the replaced values in `previous`.
 * - `revertKbChange` restores `previous` only if the touched fields still hold exactly what the change wrote (optimistic check);
 *   when someone edited them since, nothing is restored and the conflicting fields are reported.
 * Lock order is always change row, then knowledge-base row, so concurrent apply/revert never deadlock.
 */
import { Prisma } from '@prisma/client';
import { prisma, type DbClient } from './client';
import { clampLimit, encodeTimeCursor, parseTimeCursor, toPage, type Page } from './paging';
import { kbFieldsChangedSince, pickKbFields, validateKbPatch } from '@/lib/kb-patch';
import type { KbPatch, KnowledgeBase, OwnerKbChange, OwnerKbSource, OwnerKbStatus } from '@/lib/types';
import { OWNER_KB_SOURCES } from '@/lib/types';
import type { OwnerKbChange as Row } from '@prisma/client';

const toChange = (r: Row): OwnerKbChange => ({
  id: r.id, business_id: r.businessId, call_id: r.callId, source: r.source as OwnerKbSource, status: r.status as OwnerKbStatus,
  summary: r.summary, patch: (r.patch ?? {}) as KbPatch, previous: (r.previous ?? null) as KbPatch | null,
  applied_at: r.appliedAt ? r.appliedAt.toISOString() : null, reverted_at: r.revertedAt ? r.revertedAt.toISOString() : null,
  created_by: r.createdBy, created_at: r.createdAt.toISOString(),
});

type KbValues = Pick<KnowledgeBase, 'services' | 'faqs' | 'pricing_notes' | 'system_prompt' | 'call_script'>;

/** Prisma column data for a patch (domain names -> columns). */
function kbData(p: KbPatch): Prisma.KnowledgeBaseUncheckedUpdateInput {
  const d: Prisma.KnowledgeBaseUncheckedUpdateInput = {};
  if (p.services !== undefined) d.services = p.services as unknown as Prisma.InputJsonValue;
  if (p.faqs !== undefined) d.faqs = p.faqs as unknown as Prisma.InputJsonValue;
  if (p.pricing_notes !== undefined) d.pricingNotes = p.pricing_notes;
  if (p.system_prompt !== undefined) d.systemPrompt = p.system_prompt;
  if (p.call_script !== undefined) d.callScript = p.call_script;
  return d;
}

/** Lock (creating an empty one when missing) the business's knowledge-base row and return its values. */
async function lockKb(tx: DbClient, businessId: string): Promise<KbValues> {
  await tx.knowledgeBase.upsert({ where: { businessId }, update: {}, create: { businessId } });
  await tx.$queryRaw`SELECT "id" FROM "knowledge_bases" WHERE "business_id" = ${businessId} FOR UPDATE`;
  const kb = await tx.knowledgeBase.findUniqueOrThrow({ where: { businessId } });
  return {
    services: (kb.services ?? []) as unknown as KnowledgeBase['services'], faqs: (kb.faqs ?? []) as unknown as KnowledgeBase['faqs'],
    pricing_notes: kb.pricingNotes ?? '', system_prompt: kb.systemPrompt ?? '', call_script: kb.callScript ?? '',
  };
}

export class KbChangeInvalidError extends Error {
  constructor(message: string) { super(message); this.name = 'KbChangeInvalidError'; }
}

export interface ProposeKbChangeInput {
  business_id: string;
  source: OwnerKbSource;
  summary: string;
  patch: unknown;
  call_id?: string | null;
  created_by?: string | null;
}

/** Record a proposed change. Throws KbChangeInvalidError for a bad source / summary / patch (see validateKbPatch). */
export async function proposeKbChange(input: ProposeKbChangeInput): Promise<OwnerKbChange> {
  if (!OWNER_KB_SOURCES.includes(input.source)) throw new KbChangeInvalidError('invalid source');
  const summary = String(input.summary ?? '').trim();
  if (!summary) throw new KbChangeInvalidError('summary is required');
  const v = validateKbPatch(input.patch);
  if (!v.ok) throw new KbChangeInvalidError(v.error);
  const row = await prisma.ownerKbChange.create({
    data: {
      businessId: input.business_id, callId: input.call_id ?? null, source: input.source, summary: summary.slice(0, 1000),
      patch: v.patch as unknown as Prisma.InputJsonObject, createdBy: input.created_by ? input.created_by.slice(0, 200) : null,
    },
  });
  return toChange(row);
}

export async function getKbChange(businessId: string, id: string): Promise<OwnerKbChange | null> {
  const row = await prisma.ownerKbChange.findFirst({ where: { id, businessId } });
  return row ? toChange(row) : null;
}

export type KbChangeResult =
  | { ok: true; change: OwnerKbChange; changed: boolean }
  | { ok: false; reason: 'not_found' | 'not_proposed' | 'not_applied' | 'changed_since'; current?: OwnerKbStatus; conflicts?: string[] };

/**
 * Apply a proposed change: claims it (proposed -> applied), reads the current values of the touched fields into `previous` and
 * writes the knowledge base, all in one transaction (a failure rolls the claim back). Applying an already-applied change is a no-op
 * (`changed: false`); a reverted/rejected one is `not_proposed`.
 */
export async function applyKbChange(businessId: string, id: string, now: Date = new Date()): Promise<KbChangeResult> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "owner_kb_changes" SET "status" = 'applied', "applied_at" = ${now}
       WHERE "id" = ${id} AND "business_id" = ${businessId} AND "status" = 'proposed' RETURNING "id"`;
    if (claimed.length === 0) {
      const cur = await tx.ownerKbChange.findFirst({ where: { id, businessId } });
      if (!cur) return { ok: false as const, reason: 'not_found' as const };
      if (cur.status === 'applied') return { ok: true as const, change: toChange(cur), changed: false };
      return { ok: false as const, reason: 'not_proposed' as const, current: cur.status as OwnerKbStatus };
    }
    const change = await tx.ownerKbChange.findUniqueOrThrow({ where: { id } });
    const patch = (change.patch ?? {}) as KbPatch;
    const kb = await lockKb(tx, businessId);
    const previous = pickKbFields(kb, Object.keys(patch));
    await tx.knowledgeBase.update({ where: { businessId }, data: kbData(patch) });
    const row = await tx.ownerKbChange.update({ where: { id }, data: { previous: previous as unknown as Prisma.InputJsonObject } });
    return { ok: true as const, change: toChange(row), changed: true };
  }, { timeout: 15_000 });
}

/**
 * Undo an applied change. Restores `previous` ONLY when every touched field still equals what the change wrote; if any was edited
 * since (by anyone), nothing is restored and `conflicts` lists those fields. Reverting twice is a no-op.
 */
export async function revertKbChange(businessId: string, id: string, now: Date = new Date()): Promise<KbChangeResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "owner_kb_changes" WHERE "id" = ${id} AND "business_id" = ${businessId} FOR UPDATE`;
    if (rows.length === 0) return { ok: false as const, reason: 'not_found' as const };
    const cur = await tx.ownerKbChange.findUniqueOrThrow({ where: { id } });
    if (cur.status === 'reverted') return { ok: true as const, change: toChange(cur), changed: false };
    if (cur.status !== 'applied') return { ok: false as const, reason: 'not_applied' as const, current: cur.status as OwnerKbStatus };
    const patch = (cur.patch ?? {}) as KbPatch;
    const previous = (cur.previous ?? {}) as KbPatch;
    const kb = await lockKb(tx, businessId);
    const conflicts = kbFieldsChangedSince(kb, patch);
    if (conflicts.length > 0) return { ok: false as const, reason: 'changed_since' as const, current: 'applied' as const, conflicts };
    await tx.knowledgeBase.update({ where: { businessId }, data: kbData(previous) });
    const row = await tx.ownerKbChange.update({ where: { id }, data: { status: 'reverted', revertedAt: now } });
    return { ok: true as const, change: toChange(row), changed: true };
  }, { timeout: 15_000 });
}

/** proposed -> rejected (the owner said no). Idempotent for an already-rejected change. */
export async function rejectKbChange(businessId: string, id: string): Promise<KbChangeResult> {
  const res = await prisma.ownerKbChange.updateMany({ where: { id, businessId, status: 'proposed' }, data: { status: 'rejected' } });
  const cur = await prisma.ownerKbChange.findFirst({ where: { id, businessId } });
  if (!cur) return { ok: false, reason: 'not_found' };
  if (res.count === 1 || cur.status === 'rejected') return { ok: true, change: toChange(cur), changed: res.count === 1 };
  return { ok: false, reason: 'not_proposed', current: cur.status as OwnerKbStatus };
}

/** Newest first, keyset paged on (created_at, id). `cursor` is the previous page's next_cursor. */
export async function listKbChanges(
  businessId: string, opts: { limit?: number; cursor?: string | null; status?: OwnerKbStatus } = {},
): Promise<Page<OwnerKbChange>> {
  const limit = clampLimit(opts.limit);
  const cur = parseTimeCursor(opts.cursor);
  const rows = await prisma.ownerKbChange.findMany({
    where: {
      businessId, ...(opts.status ? { status: opts.status } : {}),
      ...(cur ? { OR: [{ createdAt: { lt: cur.at } }, { createdAt: cur.at, id: { lt: cur.id } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit, toChange, (r) => encodeTimeCursor(r.createdAt, r.id));
}
