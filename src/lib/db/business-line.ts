/**
 * Per-tenant AI line. Each business can own its ElevenLabs phone-number id (phnum_...) and Twilio phone sid (PN...); both are UNIQUE across
 * businesses. The shared env ELEVENLABS_PHONE_NUMBER_ID is only a FALLBACK for tenants that have no line of their own (see resolveElevenLabsPhoneNumberId).
 */
import { configEnv } from '@/lib/config';
import { prisma } from './client';
import { validateElevenLabsPhoneNumberId, validateTwilioPhoneSid } from '@/lib/business-config';
import type { Business, ID } from '@/lib/types';
import { logger } from '@/lib/log';

const log = logger('db.line');

export type SetLineResult =
  | { ok: true; business: Pick<Business, 'id' | 'elevenlabs_phone_number_id' | 'twilio_phone_sid'> }
  | { ok: false; reason: 'invalid' | 'in_use' | 'not_found'; error?: string };

/**
 * Set / clear (null) this business's line ids. Only the keys present are changed. `in_use` = another business already owns that id (never steal one).
 */
export async function setBusinessLine(businessId: ID, patch: { elevenlabs_phone_number_id?: string | null; twilio_phone_sid?: string | null }): Promise<SetLineResult> {
  const data: { elevenlabsPhoneNumberId?: string | null; twilioPhoneSid?: string | null } = {};
  if (patch.elevenlabs_phone_number_id !== undefined) {
    const v = validateElevenLabsPhoneNumberId(patch.elevenlabs_phone_number_id);
    if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
    data.elevenlabsPhoneNumberId = v.value;
  }
  if (patch.twilio_phone_sid !== undefined) {
    const v = validateTwilioPhoneSid(patch.twilio_phone_sid);
    if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
    data.twilioPhoneSid = v.value;
  }
  try {
    const row = await prisma.business.update({ where: { id: businessId }, data, select: { id: true, elevenlabsPhoneNumberId: true, twilioPhoneSid: true } });
    log.info('line.set', { business: businessId, fields: Object.keys(data) });
    return { ok: true, business: { id: row.id, elevenlabs_phone_number_id: row.elevenlabsPhoneNumberId, twilio_phone_sid: row.twilioPhoneSid } };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') return { ok: false, reason: 'in_use' };
    if (code === 'P2025') return { ok: false, reason: 'not_found' };
    throw err;
  }
}

/** Which business owns this ElevenLabs phone-number id (null = nobody; the shared fallback number has no owner). */
export async function getBusinessIdByElevenLabsPhoneNumberId(phoneNumberId: string): Promise<ID | null> {
  const row = await prisma.business.findUnique({ where: { elevenlabsPhoneNumberId: phoneNumberId }, select: { id: true } });
  return row?.id ?? null;
}

/** Which business owns this Twilio phone sid. */
export async function getBusinessIdByTwilioPhoneSid(sid: string): Promise<ID | null> {
  const row = await prisma.business.findUnique({ where: { twilioPhoneSid: sid }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * The ElevenLabs phone-number id to use for this business: its own, else the shared env fallback (ELEVENLABS_PHONE_NUMBER_ID), else null.
 * `source` says which, so callers can refuse to REASSIGN the shared number away from another tenant.
 */
export function resolveElevenLabsPhoneNumberId(
  business: Pick<Business, 'elevenlabs_phone_number_id'> | null | undefined, env: NodeJS.ProcessEnv = configEnv(),
): { id: string; source: 'business' | 'env' } | null {
  const own = business?.elevenlabs_phone_number_id?.trim();
  if (own) return { id: own, source: 'business' };
  const shared = env.ELEVENLABS_PHONE_NUMBER_ID?.trim();
  return shared ? { id: shared, source: 'env' } : null;
}
