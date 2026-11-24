/**
 * Owner-only voice tools. NEVER trust the model or the request body for "who is calling": every tool re-derives it from the DATABASE:
 *  - the call row (found by the platform's call sid / conversation id, never a model-supplied id) must be kind 'owner', still running,
 *    inside the owner-call duration, and its stored caller must still be the business's verified owner number;
 *  - nothing here changes the knowledge base. propose_kb_change only RECORDS a proposal and texts a code to the verified owner phone;
 *    the change is applied when the owner replies YES from that phone (sms.ts), so a spoofed caller id cannot change anything.
 */
import crypto from 'node:crypto';
import { findActiveCall, getBusiness, getKnowledgeBase, listKbChanges, prisma, proposeKbChange, rejectKbChange } from '@/lib/db';
import { alertOwner } from '@/lib/voice/owner-alert';
import { rateLimit } from '@/lib/ratelimit';
import { appSecretKey } from '@/lib/totp';
import { logger } from '@/lib/log';
import { detectOwnerCaller } from './detect';
import {
  OWNER_BAD_PROPOSALS_LOCKOUT, OWNER_CONFIRM_SMS_PER_HOUR, OWNER_LOCKOUT_MS, OWNER_PREVIEW_TTL_MS, OWNER_PROPOSALS_PER_CALL, ownerCallMaxSeconds,
} from './config';
import { confirmationSms, ownerCode, undoBucket, undoScope, undoSms, withinTtl } from './code';
import { buildOwnerChange } from './ops';
import { OWNER_TOOL_NAMES, type OwnerToolName } from './specs';
import { auditOwnerKb, type ChangeActor } from './apply';
import type { Business, Call } from '@/lib/types';

const log = logger('owner-tools');

export interface OwnerToolResult { ok: boolean; message: string; data?: unknown }

type Lang = 'en' | 'es';
const say = (lang: Lang, en: string, es: string): string => (lang === 'es' ? es : en);
const actor: ChangeActor = { actor_kind: 'system', via: 'voice' };

/** ElevenLabs may send "Propose KB Change" / "propose-kb-change". */
export function canonicalOwnerTool(raw: string): OwnerToolName | null {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (OWNER_TOOL_NAMES as readonly string[]).includes(key) ? (key as OwnerToolName) : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export type OwnerGate =
  | { ok: true; business: Business; call: Call; lang: Lang }
  | { ok: false; reason: string };

/**
 * The single owner gate. Pure DB facts; the only request inputs used are the platform-bound call keys (call_sid / conversation_id)
 * and the platform caller id. An LLM claim of being the owner (any extra argument) has no effect: there is no such input.
 */
export async function ownerGate(args: Record<string, unknown>, now: Date = new Date()): Promise<OwnerGate> {
  const businessId = str(args.business_id);
  if (!businessId) return { ok: false, reason: 'no_business' };
  const business = await getBusiness(businessId);
  if (!business) return { ok: false, reason: 'no_business' };
  const sid = str(args.call_sid), conv = str(args.conversation_id);
  if (!sid && !conv) return { ok: false, reason: 'no_call_key' };
  const call = await findActiveCall(business.id, { callSid: sid || undefined, conversationId: conv || undefined });
  if (!call) return { ok: false, reason: 'no_call' };
  if (call.kind !== 'owner') return { ok: false, reason: 'not_owner_call' };
  if (call.ended_at) return { ok: false, reason: 'call_ended' };
  if (now.getTime() - Date.parse(call.started_at) > (ownerCallMaxSeconds() + 30) * 1000) return { ok: false, reason: 'call_too_long' };
  // The stored caller must (still) be the verified owner number; a platform caller id in this request must agree.
  const stored = detectOwnerCaller(business, call.caller_phone);
  if (!stored.owner) return { ok: false, reason: `owner_check_${stored.reason}` };
  const platform = str(args.caller_phone);
  if (platform) {
    const live = detectOwnerCaller(business, platform);
    if (!live.owner) return { ok: false, reason: 'caller_mismatch' };
  }
  const lang: Lang = business.locale_default === 'es' || str(args.language).toLowerCase().startsWith('es') ? 'es' : 'en';
  return { ok: true, business, call, lang };
}

const lockedNow = async (businessId: string): Promise<boolean> => {
  const row = await prisma.processedEvent.findUnique({ where: { source_id: { source: 'owner-lock', id: businessId } }, select: { claimedAt: true } });
  return Boolean(row && Date.now() - row.claimedAt.getTime() < OWNER_LOCKOUT_MS);
};

async function strike(business: Business, call: Call, why: string): Promise<boolean> {
  const r = await rateLimit(`owner-callin:bad:${business.id}`, OWNER_BAD_PROPOSALS_LOCKOUT, OWNER_LOCKOUT_MS, { failClosed: true });
  await auditOwnerKb('refused', business.id, actor, null, { call: call.id, why });
  if (r.allowed) return false;
  await prisma.processedEvent.upsert({
    where: { source_id: { source: 'owner-lock', id: business.id } }, create: { source: 'owner-lock', id: business.id, status: 'done' }, update: { claimedAt: new Date() },
  });
  await auditOwnerKb('locked', business.id, actor, null, { call: call.id });
  return true;
}

const previewId = (callId: string, fingerprint: string): string => `${callId}:${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;

/** The read-back must have happened (confirmed=false with the SAME resulting patch) within OWNER_PREVIEW_TTL_MS; consumed on use. */
async function consumePreview(callId: string, fingerprint: string): Promise<boolean> {
  const res = await prisma.processedEvent.deleteMany({ where: { source: 'owner-preview', id: previewId(callId, fingerprint), claimedAt: { gte: new Date(Date.now() - OWNER_PREVIEW_TTL_MS) } } });
  return res.count === 1;
}

async function recordPreview(callId: string, fingerprint: string): Promise<void> {
  const id = previewId(callId, fingerprint);
  await prisma.processedEvent.upsert({ where: { source_id: { source: 'owner-preview', id } }, create: { source: 'owner-preview', id, status: 'done' }, update: { claimedAt: new Date() } });
}

const refusal = (lang: Lang): OwnerToolResult => ({
  ok: false,
  message: say(lang, 'That is only available on the private owner line.', 'Eso solo está disponible en la línea privada del dueño.'),
});

async function proposeTool(g: Extract<OwnerGate, { ok: true }>, args: Record<string, unknown>): Promise<OwnerToolResult> {
  const { business, call, lang } = g;
  if (await lockedNow(business.id)) {
    return { ok: false, message: say(lang, 'Too many changes were refused, so the owner line is paused for a while. You can use the dashboard instead.', 'Se rechazaron demasiados cambios, así que la línea del dueño está en pausa un rato. Puede usar el panel.') };
  }
  const used = await prisma.ownerKbChange.count({ where: { businessId: business.id, callId: call.id } });
  if (used >= OWNER_PROPOSALS_PER_CALL) {
    return { ok: false, message: say(lang, 'That is the limit of changes for one call. Please call again later.', 'Ese es el límite de cambios por llamada. Por favor llame de nuevo más tarde.') };
  }
  const kb = await getKnowledgeBase(business.id);
  if (!kb) return { ok: false, message: say(lang, 'The knowledge base is not set up yet, so I cannot change it.', 'La base de conocimiento aún no está configurada.') };
  const built = buildOwnerChange(args, kb, lang);
  if (!built.ok) {
    if (built.flagged) {
      const locked = await strike(business, call, 'flagged');
      if (locked) return { ok: false, message: say(lang, 'I cannot accept that, and the owner line is now paused for a while. You can use the dashboard instead.', 'No puedo aceptar eso, y la línea del dueño queda en pausa un rato. Puede usar el panel.') };
      return { ok: false, message: say(lang, `I cannot save that: ${built.error}. I will not change it by phone.`, `No puedo guardar eso: ${built.error}. No lo cambiaré por teléfono.`) };
    }
    return { ok: false, message: built.error };
  }
  if (args.confirmed !== true) {
    await recordPreview(call.id, built.fingerprint);
    return { ok: true, message: built.readback, data: { stage: 'read_back' } };
  }
  if (!(await consumePreview(call.id, built.fingerprint))) {
    // Never create a proposal the owner did not hear read back (or heard for different details).
    await recordPreview(call.id, built.fingerprint);
    return { ok: false, message: say(lang, `Before I can send it, let me read it back. ${built.readback}`, `Antes de enviarlo, déjeme repetirlo. ${built.readback}`), data: { stage: 'read_back' } };
  }
  const sms = await rateLimit(`owner-callin:sms:${business.id}`, OWNER_CONFIRM_SMS_PER_HOUR, 60 * 60_000, { failClosed: true });
  if (!sms.allowed) {
    return { ok: false, message: say(lang, 'I have sent too many confirmation texts this hour. Please try again later or use the dashboard.', 'He enviado demasiados mensajes de confirmación esta hora. Intente más tarde o use el panel.') };
  }
  const change = await proposeKbChange({ business_id: business.id, source: 'owner_voice', summary: built.summary, patch: built.patch, call_id: call.id, created_by: 'owner_voice' });
  const code = ownerCode(appSecretKey(), business.id, change.id);
  const sent = await alertOwner(business, confirmationSms(change.summary, code, lang), { class: 'notice' });
  await auditOwnerKb('proposed', business.id, actor, change, { call: call.id, texted: sent.notified });
  if (!sent.notified) {
    await rejectKbChange(business.id, change.id);
    return { ok: false, message: say(lang, 'I could not send the confirmation text to your phone, so nothing was changed. Please try again later or use the dashboard.', 'No pude enviar el mensaje de confirmación a su teléfono, así que no se cambió nada. Intente más tarde o use el panel.') };
  }
  return {
    ok: true,
    // The code is NEVER spoken or returned: it only exists in the text to the real owner phone.
    message: say(lang,
      'Done. I texted a confirmation code to your phone. The change is not live yet: it goes live only when you reply YES with that code in the text message.',
      'Listo. Le envié un código de confirmación por mensaje de texto. El cambio todavía no está activo: se activa solo cuando responda SI con ese código en el mensaje.'),
    data: { stage: 'proposed', change_id: change.id },
  };
}

async function listTool(g: Extract<OwnerGate, { ok: true }>): Promise<OwnerToolResult> {
  const { business, lang } = g;
  const page = await listKbChanges(business.id, { limit: 5 });
  if (page.items.length === 0) return { ok: true, message: say(lang, 'There are no changes yet.', 'Todavía no hay cambios.') };
  const word = (st: string) => (lang === 'es'
    ? ({ applied: 'aplicado', proposed: 'pendiente de confirmar', reverted: 'revertido', rejected: 'cancelado' } as Record<string, string>)[st]
    : ({ applied: 'applied', proposed: 'waiting for your text reply', reverted: 'reverted', rejected: 'cancelled' } as Record<string, string>)[st]) ?? st;
  const lines = page.items.map((c) => `${c.summary.slice(0, 120)} (${word(c.status)})`);
  return { ok: true, message: say(lang, `Your last ${lines.length} changes: ${lines.join('. ')}.`, `Sus últimos ${lines.length} cambios: ${lines.join('. ')}.`) };
}

async function undoTool(g: Extract<OwnerGate, { ok: true }>): Promise<OwnerToolResult> {
  const { business, call, lang } = g;
  if (await lockedNow(business.id)) return { ok: false, message: say(lang, 'The owner line is paused for a while. Use the dashboard to undo.', 'La línea del dueño está en pausa. Use el panel para deshacer.') };
  const page = await listKbChanges(business.id, { limit: 1, status: 'applied' });
  const last = page.items[0];
  if (!last) return { ok: false, message: say(lang, 'There is no applied change to undo.', 'No hay ningún cambio aplicado para deshacer.') };
  const sms = await rateLimit(`owner-callin:sms:${business.id}`, OWNER_CONFIRM_SMS_PER_HOUR, 60 * 60_000, { failClosed: true });
  if (!sms.allowed) return { ok: false, message: say(lang, 'I have sent too many texts this hour. Please try again later.', 'He enviado demasiados mensajes esta hora. Intente más tarde.') };
  const now = new Date();
  const scope = withinTtl(last.applied_at, now) ? 'c' : undoScope(undoBucket(now));
  const code = ownerCode(appSecretKey(), business.id, last.id, scope);
  const sent = await alertOwner(business, undoSms(last.summary, code, lang), { class: 'notice' });
  await auditOwnerKb('undo_requested', business.id, actor, last, { call: call.id, texted: sent.notified });
  if (!sent.notified) return { ok: false, message: say(lang, 'I could not send the text to your phone, so nothing was reverted.', 'No pude enviar el mensaje a su teléfono, así que no se revirtió nada.') };
  return {
    ok: true,
    message: say(lang, `I texted you a code. To undo "${last.summary.slice(0, 100)}", reply UNDO with that code. Nothing is reverted until you do.`, `Le envié un código. Para deshacer "${last.summary.slice(0, 100)}", responda DESHACER con ese código. No se revierte nada hasta que lo haga.`),
    data: { stage: 'undo_requested', change_id: last.id },
  };
}

/** Entry point from the tool route. Never throws. */
export async function runOwnerTool(name: string, args: Record<string, unknown>): Promise<OwnerToolResult> {
  const tool = canonicalOwnerTool(name);
  const lang: Lang = str(args.language).toLowerCase().startsWith('es') ? 'es' : 'en';
  if (!tool) return refusal(lang);
  try {
    const gate = await ownerGate(args);
    if (!gate.ok) {
      // Not an owner call (a customer, or a model trying the tool): refuse and leave a trace; never explain which check failed.
      log.warn('refused', { tool, reason: gate.reason, business: str(args.business_id) || null });
      const biz = str(args.business_id);
      if (biz && (gate.reason === 'not_owner_call' || gate.reason === 'caller_mismatch' || gate.reason.startsWith('owner_check_'))
        && (await rateLimit(`owner-callin:refused:${biz}`, 5, 60 * 60_000)).allowed) { // a caller cannot flood the audit trail
        await auditOwnerKb('tool_refused', biz, { actor_kind: 'system', via: 'voice' }, null, { tool, why: gate.reason });
      }
      return refusal(lang);
    }
    if (tool === 'propose_kb_change') return await proposeTool(gate, args);
    if (tool === 'list_recent_changes') return await listTool(gate);
    return await undoTool(gate);
  } catch (err) {
    log.error('failed', { tool, err });
    return { ok: false, message: say(lang, 'Something went wrong and nothing was changed. Please try again or use the dashboard.', 'Algo salió mal y no se cambió nada. Intente de nuevo o use el panel.') };
  }
}
