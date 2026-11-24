import { recordAudit } from '@/lib/db';
import { SETTINGS_ACTION } from './busy';

export async function setBlockOnBusy(businessId: string, value: boolean, actor: { user_id: string | null; kind: 'user' | 'admin_token'; ip?: string | null }): Promise<void> {
  await recordAudit({ actor_kind: actor.kind, actor_user_id: actor.user_id, business_id: businessId, action: SETTINGS_ACTION, target: `business:${businessId}`, ip: actor.ip ?? null, meta: { block_on_busy: value } });
}
