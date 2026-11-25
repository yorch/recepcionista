/**
 * The SMS side of the owner voice reply: `YES <code>` sends the drafted text to the customer, `NO <code>` cancels it. Called by handleOwnerSms
 * (sms.ts) AFTER the sender was proven to be the verified owner phone and the attempt limiter passed, so STOP-class words, strangers and
 * non-owner numbers never reach it. Returns the reply to text back to the owner, or null when the code is not a reply code (the knowledge-change
 * matcher then gets its turn). A reply code is the same stateless HMAC as the knowledge-change codes (code.ts) with its own scope ('r'), bound to
 * one business and one reply row; what makes it single-use and 30-minute is the row's status and expiry (messaging/owner-reply.ts).
 */
import { prisma } from '@/lib/db';
import { appSecretKey } from '@/lib/totp';
import { cancelOwnerReply, confirmOwnerReply, type ReplyOutcome, type ReplyRefusal } from '@/lib/messaging/owner-reply';
import { codesEqual, ownerCode, type OwnerSmsCommand } from './code';
import { ownerReplyEnabled } from './reply-config';
import type { Business } from '@/lib/types';

type Lang = 'en' | 'es';
const say = (lang: Lang, en: string, es: string): string => (lang === 'es' ? es : en);

export const REPLY_CODE_SCOPE = 'r';
export const replyCode = (businessId: string, replyId: string): string => ownerCode(appSecretKey(), businessId, replyId, REPLY_CODE_SCOPE);

async function findReplyByCode(businessId: string, code: string, now: Date): Promise<{ id: string } | null> {
  const rows = await prisma.ownerReply.findMany({ where: { businessId, createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
  const key = appSecretKey();
  return rows.find((r) => codesEqual(ownerCode(key, businessId, r.id, REPLY_CODE_SCOPE), code)) ?? null;
}

const REASON: Record<ReplyRefusal, [string, string]> = {
  disabled: ['voice replies are turned off', 'las respuestas por voz están desactivadas'],
  lead_gone: ['that customer record is no longer available', 'ese registro de cliente ya no está disponible'],
  self: ['that number is yours or the business line', 'ese número es suyo o de la línea del negocio'],
  daily_limit: ['today\'s limit of replies was reached', 'se alcanzó el límite de respuestas de hoy'],
  duplicate: ['the same text went to this customer in the last hour', 'el mismo mensaje ya se envió a este cliente en la última hora'],
  opted_out: ['this customer asked not to receive texts', 'este cliente pidió no recibir mensajes'],
  quiet_hours: ['it is quiet hours (9 PM to 8 AM) for your customers; ask again after 8 AM', 'es horario de silencio (9 PM a 8 AM) para sus clientes; pídalo de nuevo después de las 8 AM'],
  customer_limit: ['this customer already got the most texts allowed this hour', 'este cliente ya recibió el máximo de mensajes permitido esta hora'],
  too_long: ['the text would be too long', 'el mensaje sería demasiado largo'],
  no_consent: ['there is no permission on record to text this customer', 'no hay permiso registrado para escribir a este cliente'],
  cap: ['your plan\'s text allowance is used up', 'se agotó el límite de mensajes de su plan'],
  blocked: ['the text was blocked', 'el mensaje fue bloqueado'],
};

export function outcomeText(lang: Lang, o: ReplyOutcome): string {
  const who = (n: string | null) => (n ? say(lang, ` to ${n}`, ` a ${n}`) : '');
  switch (o.kind) {
    case 'sent': return say(lang, `Sent${who(o.name)}. It cannot be undone.`, `Enviado${who(o.name)}. No se puede deshacer.`);
    case 'refused': return say(lang, `Not sent: ${REASON[o.reason][0]}. Nothing was sent.`, `No se envió: ${REASON[o.reason][1]}. No se envió nada.`);
    case 'failed': return say(lang, 'The text could not be sent, and it will not be retried. Nothing more was done.', 'No se pudo enviar el mensaje y no se reintentará.');
    case 'expired': return say(lang, 'That code expired, so nothing was sent. Ask again if you still want it.', 'Ese código venció y no se envió nada. Pídalo de nuevo si todavía lo desea.');
    case 'already': return o.status === 'sent' || o.status === 'sending'
      ? say(lang, 'That text was already handled. Nothing more was sent.', 'Ese mensaje ya se gestionó. No se envió nada más.')
      : say(lang, `Nothing was sent: that reply is ${o.status}.`, `No se envió nada: esa respuesta está ${o.status}.`);
  }
}

export async function handleReplyCode(business: Business, cmd: OwnerSmsCommand, now: Date = new Date()): Promise<string | null> {
  if (!ownerReplyEnabled()) return null;
  const hit = await findReplyByCode(business.id, cmd.code, now);
  if (!hit) return null;
  const lang: Lang = business.locale_default === 'es' ? 'es' : 'en';
  if (cmd.action === 'undo') {
    return say(lang, 'A text to a customer cannot be undone once it is sent. Reply NO with the code only before it goes out.', 'Un mensaje a un cliente no se puede deshacer una vez enviado. Responda NO con el código solo antes de que salga.');
  }
  if (cmd.action === 'no') {
    const r = await cancelOwnerReply(business, hit.id, now);
    if (r.cancelled) return say(lang, 'Cancelled. Nothing was sent to the customer.', 'Cancelado. No se envió nada al cliente.');
    return say(lang, `Too late to cancel: that reply is ${r.status}.`, `Ya no se puede cancelar: esa respuesta está ${r.status}.`);
  }
  return outcomeText(lang, await confirmOwnerReply(business, hit.id, now));
}
