/** Names for the audit log view (server only): the business name and the admin e-mail behind an audit row's ids. One query each for a whole page. */
import { prisma } from '@/lib/db/client';
import type { AuditRowView } from './audit-search';

export type AuditRowEnriched = AuditRowView & { business_name: string | null; actor_email: string | null };

export async function enrichAudit(items: AuditRowView[]): Promise<AuditRowEnriched[]> {
  const bizIds = [...new Set(items.map((i) => i.business_id).filter((x): x is string => Boolean(x)))];
  const userIds = [...new Set(items.map((i) => i.actor_user_id).filter((x): x is string => Boolean(x)))];
  const [biz, users] = await Promise.all([
    bizIds.length ? prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
  ]);
  const b = new Map(biz.map((x) => [x.id, x.name]));
  const u = new Map(users.map((x) => [x.id, x.email]));
  return items.map((i) => ({ ...i, business_name: i.business_id ? b.get(i.business_id) ?? null : null, actor_email: i.actor_user_id ? u.get(i.actor_user_id) ?? null : null }));
}
