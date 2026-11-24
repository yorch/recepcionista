import { prisma, recordAudit } from '@/lib/db';
import { SETTINGS_ACTION } from './busy';

/** Persist the "block busy time" switch on the connection (column `calendar_connections.block_on_busy`) and audit it. False = no connection. */
export async function setBlockOnBusy(businessId: string, value: boolean, actor: { user_id: string | null; kind: 'user' | 'admin_token'; ip?: string | null }): Promise<boolean> {
  const res = await prisma.calendarConnection.updateMany({ where: { businessId, provider: 'google' }, data: { blockOnBusy: value } });
  if (res.count === 0) return false;
  await recordAudit({ actor_kind: actor.kind, actor_user_id: actor.user_id, business_id: businessId, action: SETTINGS_ACTION, target: `business:${businessId}`, ip: actor.ip ?? null, meta: { block_on_busy: value } });
  return true;
}
