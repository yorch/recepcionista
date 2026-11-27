/**
 * Audit search and export for the console (Phase 7). Node runtime only.
 * Filters: actor (user id or `admin_token` / `system` / `webhook`), action (exact, or a `prefix.` ending in a dot), business, date range, free text (action, target and the
 * meta text, case-insensitive). Keyset pagination on (at, id) newest first. CSV is hardened against spreadsheet formula injection. Exports are audited by the route.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { SettingsError } from './settings-store';

export interface AuditQuery { actor?: string; action?: string; business_id?: string; from?: string; to?: string; q?: string; before?: string; limit?: number }
export interface AuditRowView { id: string; at: string; actor_kind: string; actor_user_id: string | null; business_id: string | null; action: string; target: string; ip: string | null; meta: unknown }

export const AUDIT_EXPORT_MAX = 5000;

function parseDate(v: string | undefined, name: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new SettingsError(422, 'invalid_filter', `${name} must be an ISO date`);
  return d;
}

const like = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function searchAudit(q: AuditQuery, opts: { max?: number } = {}): Promise<{ items: AuditRowView[]; next_cursor: string | null }> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), opts.max ?? 200);
  const from = parseDate(q.from, 'from');
  const to = parseDate(q.to, 'to');
  const conds: Prisma.Sql[] = [];
  if (q.actor) conds.push(['admin_token', 'system', 'webhook', 'user'].includes(q.actor) ? Prisma.sql`actor_kind = ${q.actor}` : Prisma.sql`actor_user_id = ${q.actor}`);
  if (q.action) conds.push(q.action.endsWith('.') ? Prisma.sql`action LIKE ${`${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : Prisma.sql`action = ${q.action}`);
  if (q.business_id) conds.push(Prisma.sql`business_id = ${q.business_id}`);
  if (from) conds.push(Prisma.sql`at >= ${from}`);
  if (to) conds.push(Prisma.sql`at <= ${to}`);
  if (q.q) { const p = like(q.q.slice(0, 100)); conds.push(Prisma.sql`(action ILIKE ${p} OR target ILIKE ${p} OR meta::text ILIKE ${p})`); }
  if (q.before) {
    const i = q.before.indexOf('~');
    const at = new Date(i === -1 ? q.before : q.before.slice(0, i));
    if (Number.isNaN(at.getTime())) throw new SettingsError(422, 'invalid_cursor', 'invalid cursor');
    const id = i === -1 ? null : q.before.slice(i + 1);
    conds.push(id ? Prisma.sql`(at < ${at} OR (at = ${at} AND id < ${id}))` : Prisma.sql`at < ${at}`);
  }
  const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: string; at: Date; actor_kind: string; actor_user_id: string | null; business_id: string | null; action: string; target: string; ip: string | null; meta: unknown }[]>`
    SELECT id, at, actor_kind, actor_user_id, business_id, action, target, ip, meta FROM audit_events ${where} ORDER BY at DESC, id DESC LIMIT ${take + 1}`;
  const page = rows.slice(0, take);
  return {
    items: page.map((r) => ({ id: r.id, at: r.at.toISOString(), actor_kind: r.actor_kind, actor_user_id: r.actor_user_id, business_id: r.business_id, action: r.action, target: r.target, ip: r.ip, meta: r.meta })),
    next_cursor: rows.length > take ? `${page[page.length - 1].at.toISOString()}~${page[page.length - 1].id}` : null,
  };
}

/** One CSV cell: quoted, quotes doubled, and a leading = + - @ TAB or CR neutralised with a quote (formula injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function auditCsv(rows: AuditRowView[]): string {
  const head = ['id', 'at', 'actor_kind', 'actor_user_id', 'business_id', 'action', 'target', 'ip', 'meta'];
  return `${[head.join(','), ...rows.map((r) => [r.id, r.at, r.actor_kind, r.actor_user_id, r.business_id, r.action, r.target, r.ip, r.meta].map(csvCell).join(','))].join('\n')}\n`;
}
