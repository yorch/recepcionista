/**
 * Append-only audit trail (security-relevant account and billing actions). Node runtime only.
 * `meta` is small structured context: NEVER put secrets, tokens, passwords or message bodies in it.
 */
import { prisma } from './client';
import { logger } from '@/lib/log';
import type { AuditActorKind, AuditEvent } from '@/lib/types';

const log = logger('audit');
const SECRET_KEY = /(password|token|secret|authorization|cookie|api[-_]?key|otp|recovery)/i;
const MAX_META_BYTES = 4000;

export interface AuditInput {
  actor_kind: AuditActorKind;
  actor_user_id?: string | null;
  business_id?: string | null;
  /** Dotted verb, e.g. 'auth.login', 'auth.login_failed', 'user.invite', 'billing.subscription_updated'. */
  action: string;
  /** What was acted on: an id or short label ('user:<id>', 'business:<id>'). */
  target?: string;
  ip?: string | null;
  meta?: Record<string, unknown>;
  at?: Date;
}

/** Drop secret-looking keys (top level and one level down) and cap the size; defence in depth, not a licence. */
export function sanitizeAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const clean = (o: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (SECRET_KEY.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && depth < 1 ? clean(v as Record<string, unknown>, depth + 1) : v;
    }
    return out;
  };
  const out = clean(meta ?? {}, 0);
  return JSON.stringify(out).length > MAX_META_BYTES ? { truncated: true } : out;
}

/**
 * Record an audit event. NEVER throws (auditing must not break the request it describes); a failure is
 * logged at error level. Returns whether the row was written. Await it for security events so the row
 * exists before the response, or `void` it on hot paths.
 */
export async function recordAudit(input: AuditInput): Promise<boolean> {
  try {
    await prisma.auditEvent.create({
      data: {
        at: input.at ?? new Date(),
        actorKind: input.actor_kind,
        actorUserId: input.actor_user_id ?? null,
        businessId: input.business_id ?? null,
        action: input.action.slice(0, 120),
        target: (input.target ?? '').slice(0, 200),
        ip: input.ip ? input.ip.slice(0, 64) : null,
        meta: sanitizeAuditMeta(input.meta) as object,
      },
    });
    return true;
  } catch (err) {
    log.error('audit.write_failed', { action: input.action, error: (err as Error).message });
    return false;
  }
}

/** Opaque-ish page cursor: the (at, id) of the last row of a page, `<iso>~<id>`. */
export function auditCursor(e: Pick<AuditEvent, 'at' | 'id'>): string {
  return `${e.at}~${e.id}`;
}

/** Parse a cursor: `<iso>~<id>` (composite) or a bare ISO timestamp (legacy, timestamp only). Null when malformed. */
export function parseAuditCursor(raw: string | undefined | null): { at: Date; id: string | null } | null {
  if (!raw) return null;
  const k = raw.indexOf('~');
  const iso = k === -1 ? raw : raw.slice(0, k);
  const id = k === -1 ? null : raw.slice(k + 1);
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || (id !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(id))) return null;
  return { at, id };
}

/**
 * Newest first (at DESC, id DESC). `before` is the previous page's cursor (see auditCursor), exclusive: rows that
 * share the cursor's timestamp are paged by id, so events with equal timestamps are neither skipped nor repeated.
 * A bare ISO timestamp is still accepted (strictly older rows only).
 */
export async function listAuditEvents(opts: {
  business_id?: string; actor_user_id?: string; action?: string; before?: string; limit?: number;
} = {}): Promise<AuditEvent[]> {
  const cur = parseAuditCursor(opts.before);
  const rows = await prisma.auditEvent.findMany({
    where: {
      ...(opts.business_id ? { businessId: opts.business_id } : {}),
      ...(opts.actor_user_id ? { actorUserId: opts.actor_user_id } : {}),
      ...(opts.action ? { action: opts.action } : {}),
      ...(cur
        ? { OR: [{ at: { lt: cur.at } }, ...(cur.id ? [{ at: cur.at, id: { lt: cur.id } }] : [])] }
        : {}),
    },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 500),
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor_user_id: r.actorUserId,
    actor_kind: r.actorKind as AuditActorKind,
    business_id: r.businessId,
    action: r.action,
    target: r.target,
    ip: r.ip,
    meta: (r.meta ?? {}) as Record<string, unknown>,
  }));
}
