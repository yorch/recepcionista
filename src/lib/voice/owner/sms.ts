/**
 * Owner SMS commands: "YES <code>" applies a proposed knowledge change, "NO <code>" cancels it, "UNDO <code>" reverts it.
 * This is the SECOND CHANNEL that makes owner call-in safe: the Twilio webhook is signed, the sender must be the business's verified owner
 * phone, and the code was only ever sent to that phone. Called by /api/sms/inbound AFTER signature verification and STOP/START/HELP
 * handling, so opt-out keywords always win. Returns the reply text, or null when the message is not for us (so the route carries on).
 */
import { getKbChange, prisma } from '@/lib/db';
import { toE164, phoneCountry } from '@/lib/phone';
import { rateLimit } from '@/lib/ratelimit';
import { appSecretKey } from '@/lib/totp';
import { logger } from '@/lib/log';
import { ownerCallinEnabled } from './config';
import { codesEqual, ownerCode, parseOwnerSms, undoBucket, undoScope, withinTtl } from './code';
import { handleBareReplyAnswer, handleReplyCode } from './reply-sms';
import { applyOwnerChange, auditOwnerKb, rejectOwnerChange, revertOwnerChange, type ChangeActor } from './apply';
import type { Business, OwnerKbChange } from '@/lib/types';
import { planAllows } from '@/lib/admin/plan-catalog';

const log = logger('owner-sms');
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

const actor = (): ChangeActor => ({ actor_kind: 'system', via: 'sms' });

export const isVerifiedOwnerSender = (business: Pick<Business, 'owner_phone_e164' | 'owner_phone_verified_at'>, from: string): boolean => {
  const owner = business.owner_phone_e164 ?? null;
  if (!owner || !business.owner_phone_verified_at || !from || /[a-z]/i.test(from)) return false;
  return toE164(from, phoneCountry(owner) ?? undefined) === owner;
};

interface Match { change: OwnerKbChange; scope: string }

/** The change (of THIS business) the code belongs to, among recent ones. Pure comparison over at most 100 rows. */
async function findByCode(businessId: string, code: string, now: Date): Promise<Match | null> {
  const rows = await prisma.ownerKbChange.findMany({
    where: { businessId, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true },
  });
  // The newest APPLIED change is always a candidate, whatever its age or position: a voice UNDO of it texts a code for it, and that
  // code must validate even when it is older than 7 days or more than 100 changes ago.
  const newestApplied = await prisma.ownerKbChange.findFirst({ where: { businessId, status: 'applied' }, orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  if (newestApplied && !rows.some((r) => r.id === newestApplied.id)) rows.push(newestApplied);
  const key = appSecretKey();
  const bucket = undoBucket(now);
  for (const r of rows) {
    for (const scope of ['c', undoScope(bucket), undoScope(bucket - 1)]) {
      if (codesEqual(ownerCode(key, businessId, r.id, scope), code)) {
        const change = await getKbChange(businessId, r.id);
        if (change) return { change, scope };
      }
    }
  }
  return null;
}

export async function handleOwnerSms(business: Business, from: string, body: string | null | undefined, now: Date = new Date()): Promise<string | null> {
  if (!ownerCallinEnabled() || !planAllows(business.plan, 'owner_callin')) return null;
  const cmd = parseOwnerSms(body);
  if (!cmd) {
    // A bare NO / YES from the owner phone while a drafted customer reply is waiting (the spoof warning's cancel path). Strangers get nothing.
    if (!isVerifiedOwnerSender(business, from)) return null;
    return handleBareReplyAnswer(business, body, now);
  }
  // Anyone else typing "YES K7M2QX" is just a stranger's text: no reply, nothing revealed, nothing changed.
  if (!isVerifiedOwnerSender(business, from)) return null;
  const es = business.locale_default === 'es';
  const t = (en: string, esText: string) => (es ? esText : en);

  const gate = await rateLimit(`owner-sms:attempts:${business.id}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS, { failClosed: true });
  if (!gate.allowed) return t('Too many attempts. Please wait a few minutes.', 'Demasiados intentos. Espere unos minutos.');

  // A code from a drafted customer reply (voice reply channel) is handled there; any other code falls through to the knowledge changes.
  const replyAnswer = await handleReplyCode(business, cmd, now);
  if (replyAnswer !== null) return replyAnswer;

  const match = await findByCode(business.id, cmd.code, now);
  if (!match) {
    log.warn('bad_code', { business: business.id, action: cmd.action });
    return t('That code is not valid.', 'Ese código no es válido.');
  }
  const { change, scope } = match;
  const fresh = (await getKbChange(business.id, change.id)) ?? change;
  const tag = fresh.summary.length > 110 ? `${fresh.summary.slice(0, 107)}...` : fresh.summary;

  if (cmd.action === 'undo') {
    if (scope === 'c' && !withinTtl(fresh.applied_at, now)) return t('That code expired. Ask for the undo again, or use the dashboard.', 'Ese código venció. Pida deshacer de nuevo o use el panel.');
    const res = await revertOwnerChange(business.id, fresh.id, actor());
    if (res.ok) return res.changed ? t(`Reverted: ${tag}.`, `Revertido: ${tag}.`) : t('That change was already reverted.', 'Ese cambio ya estaba revertido.');
    if (res.reason === 'changed_since') return t(`Not reverted: ${(res.conflicts ?? []).join(', ')} was edited since. Use the dashboard to review.`, `No se revirtió: ${(res.conflicts ?? []).join(', ')} se editó después. Revise en el panel.`);
    return t(`Nothing to undo: that change is ${res.current ?? 'not applied'}.`, `Nada que deshacer: ese cambio está ${res.current ?? 'sin aplicar'}.`);
  }

  // YES / NO only ever concern a proposal made with the base code, inside its 30 minutes.
  if (scope !== 'c') return t('That code is not valid for this reply.', 'Ese código no es válido para esta respuesta.');
  if (fresh.status === 'proposed' && !withinTtl(fresh.created_at, now)) {
    await rejectOwnerChange(business.id, fresh.id, actor());
    await auditOwnerKb('expired', business.id, actor(), fresh);
    return t('That code expired, so nothing was changed. Ask again if you still want it.', 'Ese código venció y no se cambió nada. Pídalo de nuevo si todavía lo desea.');
  }
  if (cmd.action === 'no') {
    const res = await rejectOwnerChange(business.id, fresh.id, actor());
    return res.ok ? t(`Cancelled: ${tag}. Nothing was changed.`, `Cancelado: ${tag}. No se cambió nada.`) : t(`Too late to cancel: that change is ${res.current ?? 'already decided'}. Reply UNDO ${cmd.code} to revert it.`, `Ya no se puede cancelar: ese cambio está ${res.current ?? 'decidido'}. Responda DESHACER ${cmd.code} para revertirlo.`);
  }
  const res = await applyOwnerChange(business.id, fresh.id, actor());
  if (res.ok) {
    return res.changed
      ? t(`Applied: ${tag}. Reply UNDO ${cmd.code} within 30 min to revert.`, `Aplicado: ${tag}. Responda DESHACER ${cmd.code} en 30 min para revertir.`)
      : t('That change was already applied. Nothing more was done.', 'Ese cambio ya estaba aplicado. No se hizo nada más.');
  }
  if (res.reason === 'stale') return t('Not applied: your knowledge was edited after this was proposed. Ask again so nothing is overwritten.', 'No se aplicó: su información se editó después de esta propuesta. Pídalo de nuevo para no sobrescribir nada.');
  return t(`Not applied: that change is ${res.reason === 'not_found' ? 'unknown' : (res.current ?? 'no longer pending')}.`, `No se aplicó: ese cambio está ${res.reason === 'not_found' ? 'desconocido' : (res.current ?? 'ya no pendiente')}.`);
}
