/**
 * Owner alerts from the voice side (emergency, handoff, out-of-service notices). Honest by construction: `notified`
 * is true ONLY if the text really went out (or demo mode), and an alert is only attempted to a VERIFIED owner phone.
 */
import { sendAndLog } from '@/lib/messaging';
import { ownerAlertStatus } from '@/lib/messaging/owner';
import { logger } from '@/lib/log';
import type { Business, SmsLog } from '@/lib/types';

const log = logger('owner-alert');

export interface OwnerAlert {
  /** True ONLY if the SMS really went out (or demo mode mock). Never claim the owner was told otherwise. */
  notified: boolean;
  reason: 'sent' | 'no_owner_phone' | 'owner_unverified' | 'sms_failed' | 'sms_error';
  sms: SmsLog | null;
}

export async function alertOwner(business: Business, body: string): Promise<OwnerAlert> {
  const status = ownerAlertStatus(business);
  if (status === 'no_owner_phone') {
    log.error('owner_alert.no_owner_phone', { business: business.id });
    return { notified: false, reason: 'no_owner_phone', sms: null };
  }
  if (status === 'unverified') {
    log.error('owner_alert.owner_unverified', { business: business.id, action: 'owner must verify their phone (Settings)' });
    return { notified: false, reason: 'owner_unverified', sms: null };
  }
  try {
    const { sms, result: sent, blocked } = await sendAndLog({
      business_id: business.id, to: business.owner_phone as string, body, kind: 'owner_alert',
    });
    if (blocked) {
      log.error('owner_alert.blocked', { business: business.id, blocked });
      return { notified: false, reason: blocked === 'blocked_owner_unverified' ? 'owner_unverified' : 'sms_failed', sms };
    }
    // 'mock' means no Twilio configured: only counts as delivered in explicit demo mode.
    const delivered = sent.status === 'sent' || (sent.status === 'mock' && process.env.DEMO_MODE === 'true');
    if (!delivered) log.error('owner_alert.not_delivered', { business: business.id, status: sent.status, error: sent.error ?? null });
    return { notified: delivered, reason: delivered ? 'sent' : 'sms_failed', sms };
  } catch (err) {
    log.error('owner_alert.error', { business: business.id, err });
    return { notified: false, reason: 'sms_error', sms: null };
  }
}
