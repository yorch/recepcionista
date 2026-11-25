/**
 * Owner-line tools for the VOICE REPLY channel: list_recent_leads, draft_reply, mark_lead_handled, get_callback_number. Called by runOwnerTool
 * (tools.ts) AFTER the owner gate passed (call row kind 'owner', still running, stored caller = the verified owner number).
 *
 *  - the model never chooses the recipient: it passes a small lead number the SERVER issued on this call, and the number is re-derived from the
 *    lead row of this business (reply-leads.ts);
 *  - a draft only RECORDS a proposed reply and texts the owner a code with the exact words; the customer is texted only by YES <code> from the
 *    owner phone (reply-sms.ts, messaging/owner-reply.ts);
 *  - leads are described by structured fields only (kind, first name, last 4 digits, time): no customer free text, transcript or summary is read out.
 */
import crypto from 'node:crypto';
import { countryForBusiness, isOptedOut, prisma } from '@/lib/db';
import { alertOwner } from '@/lib/voice/owner-alert';
import { auditReply } from '@/lib/messaging/owner-reply';
import { rateLimit } from '@/lib/ratelimit';
import { tzOf } from '@/lib/time';
import { logger } from '@/lib/log';
import { attestationLevel } from '@/lib/stir';
import { callClock } from './code';
import { OWNER_CONFIRM_SMS_PER_HOUR, OWNER_LOCKOUT_MS, OWNER_BAD_PROPOSALS_LOCKOUT, OWNER_PREVIEW_TTL_MS, ownerBudgetId, ownerTrustOf } from './config';
import {
  OWNER_REPLY_DRAFTS_PER_CALL, OWNER_REPLY_HANDLED_PER_CALL, OWNER_REPLY_LISTS_PER_HOUR, OWNER_REPLY_TTL_MS, ownerReplyDailyLimit, ownerReplyEnabled, ownerReplyRequiresAttestation,
} from './reply-config';
import { markHandled, reserveHandled, resolveLead, snapshotLeads } from './reply-leads';
import { replyCode } from './reply-sms';
import { bodyProblemMessage, customerReplyText, last4Of, leadLine, ownerReplyConfirmSms, ownerTextFits, parseLeadRef, validateReplyBody } from './reply-text';
import { auditOwnerKb } from './apply';
import type { OwnerGate, OwnerToolResult } from './tools';
import type { OwnerReplyToolName } from './specs';

const log = logger('owner-reply-tools');
type Lang = 'en' | 'es';
const say = (lang: Lang, en: string, es: string): string => (lang === 'es' ? es : en);
type Gate = Extract<OwnerGate, { ok: true }>;

const budgetOf = (g: Gate): string => ownerBudgetId(g.business.id, ownerTrustOf(g.call));

async function locked(budget: string): Promise<boolean> {
  const row = await prisma.processedEvent.findUnique({ where: { source_id: { source: 'owner-lock', id: budget } }, select: { claimedAt: true } });
  return Boolean(row && Date.now() - row.claimedAt.getTime() < OWNER_LOCKOUT_MS);
}

/** An attack-looking draft counts toward the same lockout as attack-looking knowledge proposals (same budget class). */
async function strike(g: Gate, why: string): Promise<boolean> {
  const budget = budgetOf(g);
  const r = await rateLimit(`owner-callin:bad:${budget}`, OWNER_BAD_PROPOSALS_LOCKOUT, OWNER_LOCKOUT_MS, { failClosed: true });
  await auditOwnerKb('refused', g.business.id, { actor_kind: 'system', via: 'voice' }, null, { call: g.call.id, why, tool: 'draft_reply' });
  if (r.allowed) return false;
  await prisma.processedEvent.upsert({ where: { source_id: { source: 'owner-lock', id: budget } }, create: { source: 'owner-lock', id: budget, status: 'done' }, update: { claimedAt: new Date() } });
  await auditOwnerKb('locked', g.business.id, { actor_kind: 'system', via: 'voice' }, null, { call: g.call.id, trust: ownerTrustOf(g.call) });
  return true;
}

const previewId = (callId: string, fingerprint: string): string => `${callId}:${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
async function consumePreview(callId: string, fingerprint: string): Promise<boolean> {
  const res = await prisma.processedEvent.deleteMany({ where: { source: 'owner-reply-preview', id: previewId(callId, fingerprint), claimedAt: { gte: new Date(Date.now() - OWNER_PREVIEW_TTL_MS) } } });
  return res.count === 1;
}
async function recordPreview(callId: string, fingerprint: string): Promise<void> {
  const id = previewId(callId, fingerprint);
  await prisma.processedEvent.upsert({ where: { source_id: { source: 'owner-reply-preview', id } }, create: { source: 'owner-reply-preview', id, status: 'done' }, update: { claimedAt: new Date() } });
}

const fail = (lang: Lang, en: string, es: string): OwnerToolResult => ({ ok: false, message: say(lang, en, es) });

/** The gate for every reply tool: feature on, call attested when the operator demands it, line not locked. */
async function precheck(g: Gate): Promise<OwnerToolResult | null> {
  const { lang } = g;
  if (!ownerReplyEnabled()) return fail(lang, 'Replying to customers by phone is turned off. You can text them from your own phone.', 'Responder a clientes por teléfono está desactivado. Puede escribirles desde su propio teléfono.');
  if (ownerReplyRequiresAttestation() && !(g.call.caller_verified === true || attestationLevel(g.call.stir_status) === 'A')) {
    return fail(lang, 'This call is not verified by the carrier, so I cannot work with customer details on it. Please use the dashboard.', 'Esta llamada no está verificada por el operador, así que no puedo trabajar con datos de clientes. Use el panel.');
  }
  if (await locked(budgetOf(g))) return fail(lang, 'The owner line is paused for a while. Please try again later or use the dashboard.', 'La línea del dueño está en pausa un rato. Intente más tarde o use el panel.');
  return null;
}

async function listLeads(g: Gate): Promise<OwnerToolResult> {
  const { business, call, lang } = g;
  const rl = await rateLimit(`owner-reply:list:${call.id}`, OWNER_REPLY_LISTS_PER_HOUR, 3600_000, { failClosed: true });
  if (!rl.allowed) return fail(lang, 'That is enough lists for one call. Please call again later.', 'Ya hubo suficientes listas en esta llamada. Llame de nuevo más tarde.');
  const now = new Date();
  const trust = ownerTrustOf(call);
  const { leads, capped } = await snapshotLeads(business, call, now, trust);
  if (leads.length === 0 && capped) {
    // The daily disclosure budget of this identity class is spent: say so without revealing anything.
    return fail(lang, 'I have already read out the most customers this line may hear about today. Please use the dashboard, or try again tomorrow.', 'Ya leí el máximo de clientes que esta línea puede escuchar hoy. Use el panel o intente mañana.');
  }
  if (leads.length === 0) return { ok: true, message: say(lang, 'There are no recent customers waiting for a reply.', 'No hay clientes recientes esperando respuesta.'), data: { stage: 'leads', count: 0 } };
  const tz = tzOf(business);
  const lines = leads.map((l) => leadLine(lang, l, now, tz, callClock(l.at, tz) || ''));
  await auditReply('leads_listed', business.id, null, { call: call.id, count: leads.length, capped, trust });
  return {
    ok: true,
    message: say(lang,
      `${lines.join(' ')} ${capped ? 'That is all this line can read out today. ' : ''}Say the number of the customer you want to reply to. Only these numbers work on this call.`,
      `${lines.join(' ')} ${capped ? 'Eso es todo lo que esta línea puede leer hoy. ' : ''}Diga el número del cliente al que quiere responder. Solo estos números sirven en esta llamada.`),
    data: { stage: 'leads', count: leads.length },
  };
}

async function draft(g: Gate, args: Record<string, unknown>): Promise<OwnerToolResult> {
  const { business, call, lang } = g;
  const n = parseLeadRef(args.lead_ref);
  if (!n) return fail(lang, 'Tell me the number of the customer from the list first. I can list them now.', 'Dígame primero el número del cliente de la lista. Puedo leerla ahora.');
  const now = new Date();
  const lead = await resolveLead(business, call, n, now);
  if (!lead) return fail(lang, 'I do not have a customer with that number on this call. Let me list them again first.', 'No tengo un cliente con ese número en esta llamada. Primero voy a leer la lista otra vez.');
  const to = lead.name ?? say(lang, 'the customer', 'el cliente');
  if (await isOptedOut(business.id, lead.e164, countryForBusiness(business))) {
    return fail(lang, `${to} asked not to receive texts from this business, so I cannot send one. I can text you their callback number instead.`, `${to} pidió no recibir mensajes de este negocio, así que no puedo enviar uno. Puedo enviarle su número por mensaje para que lo llame.`);
  }
  const used = await prisma.ownerReply.count({ where: { businessId: business.id, callId: call.id } });
  if (used >= OWNER_REPLY_DRAFTS_PER_CALL) return fail(lang, 'That is the limit of replies for one call. Please call again later.', 'Ese es el límite de respuestas por llamada. Llame de nuevo más tarde.');
  const trust = ownerTrustOf(call);
  const drafted = await prisma.ownerReply.count({ where: { businessId: business.id, ownerTrust: trust, createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } } });
  if (drafted >= ownerReplyDailyLimit()) return fail(lang, 'The limit of replies for today was reached. Please try again tomorrow or text the customer yourself.', 'Se alcanzó el límite de respuestas de hoy. Intente mañana o escriba usted al cliente.');

  const v = validateReplyBody(args.message);
  if (!v.ok) {
    if (v.flagged) {
      const lockedNow = await strike(g, `reply_${v.problem}`);
      if (lockedNow) return fail(lang, 'I cannot accept that, and the owner line is now paused for a while. You can use the dashboard instead.', 'No puedo aceptar eso, y la línea del dueño queda en pausa un rato. Puede usar el panel.');
    }
    return { ok: false, message: bodyProblemMessage(v.problem, lang) };
  }
  const text = customerReplyText(business.name, v.body);
  if (!text.ok) return { ok: false, message: bodyProblemMessage('too_long_sms', lang) };

  const readback = say(lang,
    `I will text ${to} (number ending ${lead.last4}) from ${business.name}: "${v.body}". I will first text you a code; it is sent only when you reply YES with that code, it cannot be unsent, and you can cancel with NO. Is that right?`,
    `Le enviaré a ${to} (número que termina en ${lead.last4}) desde ${business.name}: "${v.body}". Primero le enviaré un código; solo se envía cuando usted responda SI con ese código, no se puede deshacer y puede cancelar con NO. ¿Es correcto?`);
  const fingerprint = `${lead.rowKind}:${lead.rowId}|${v.body}`;
  if (args.confirmed !== true) {
    await recordPreview(call.id, fingerprint);
    return { ok: true, message: readback, data: { stage: 'read_back' } };
  }
  if (!(await consumePreview(call.id, fingerprint))) {
    await recordPreview(call.id, fingerprint);
    return { ok: false, message: say(lang, `Before I can send it, let me read it back. ${readback}`, `Antes de enviarlo, déjeme repetirlo. ${readback}`), data: { stage: 'read_back' } };
  }

  // The same words for the same customer, still waiting: do not create or text a second code.
  const waiting = await prisma.ownerReply.findFirst({ where: { businessId: business.id, toE164: lead.e164, body: v.body, status: 'proposed', expiresAt: { gt: now } } });
  if (waiting) {
    return { ok: true, message: say(lang, 'That reply is already waiting for your YES. Check the text with the code.', 'Esa respuesta ya espera su SI. Revise el mensaje con el código.'), data: { stage: 'proposed', reply_id: waiting.id } };
  }
  const sms = await rateLimit(`owner-callin:sms:${budgetOf(g)}`, OWNER_CONFIRM_SMS_PER_HOUR, 3600_000, { failClosed: true });
  if (!sms.allowed) return fail(lang, 'I have sent too many confirmation texts this hour. Please try again later or use the dashboard.', 'He enviado demasiados mensajes de confirmación esta hora. Intente más tarde o use el panel.');

  const reply = await prisma.ownerReply.create({
    data: {
      businessId: business.id, callId: call.id, leadKind: lead.rowKind, leadCallId: lead.rowKind === 'call' ? lead.rowId : null, leadBookingId: lead.rowKind === 'booking' ? lead.rowId : null,
      toE164: lead.e164, toName: lead.name, body: v.body, segments: text.segments, ownerTrust: trust, expiresAt: new Date(now.getTime() + OWNER_REPLY_TTL_MS),
    },
  });
  const code = replyCode(business.id, reply.id);
  const confirm = ownerReplyConfirmSms(lang, { name: lead.name, last4: lead.last4, body: v.body, code, callAt: callClock(call.started_at, tzOf(business)) || undefined });
  if (!ownerTextFits(confirm)) { // cannot happen with the body cap, but the owner must never approve words they could not see in full
    await prisma.ownerReply.update({ where: { id: reply.id }, data: { status: 'refused', refuseReason: 'confirm_too_long', decidedAt: new Date() } });
    return { ok: false, message: bodyProblemMessage('too_long', lang) };
  }
  const sent = await alertOwner(business, confirm, { class: 'notice' });
  await auditReply('proposed', business.id, reply, { call: call.id, texted: sent.notified, trust });
  if (!sent.notified) {
    await prisma.ownerReply.update({ where: { id: reply.id }, data: { status: 'failed', refuseReason: 'confirm_text', decidedAt: new Date() } });
    return fail(lang, 'I could not send the confirmation text to your phone, so nothing will be sent to the customer. Please try again later.', 'No pude enviar el mensaje de confirmación a su teléfono, así que no se enviará nada al cliente. Intente más tarde.');
  }
  log.info('proposed', { business: business.id, reply: reply.id });
  return {
    ok: true,
    // The code is never spoken or returned: it only exists in the text to the real owner phone.
    message: say(lang,
      'Done. I texted a code to your phone with the exact words. Nothing goes to the customer until you reply YES with that code. A sent text cannot be undone, and NO with the code cancels it. It expires in 30 minutes.',
      'Listo. Le envié un código a su teléfono con las palabras exactas. No se envía nada al cliente hasta que responda SI con ese código. Un mensaje enviado no se puede deshacer, y NO con el código lo cancela. Vence en 30 minutos.'),
    data: { stage: 'proposed', reply_id: reply.id },
  };
}

async function handled(g: Gate, args: Record<string, unknown>): Promise<OwnerToolResult> {
  const { business, call, lang } = g;
  const n = parseLeadRef(args.lead_ref);
  const lead = n ? await resolveLead(business, call, n) : null;
  if (!lead) return fail(lang, 'I do not have a customer with that number on this call. Let me list them first.', 'No tengo un cliente con ese número en esta llamada. Primero voy a leer la lista.');
  const trust = ownerTrustOf(call);
  const to = lead.name ?? say(lang, 'that customer', 'ese cliente');
  const readback = say(lang,
    `I will mark ${to} (number ending ${lead.last4}) as handled, so they are not listed again. Is that right?`,
    `Marcaré a ${to} (número que termina en ${lead.last4}) como atendido, para que no vuelva a aparecer. ¿Es correcto?`);
  const fingerprint = `handled:${lead.rowKind}:${lead.rowId}`;
  if (args.confirmed !== true) {
    await recordPreview(call.id, fingerprint);
    return { ok: true, message: readback, data: { stage: 'read_back' } };
  }
  if (!(await consumePreview(call.id, fingerprint))) {
    await recordPreview(call.id, fingerprint);
    return { ok: false, message: say(lang, `Before I can do that, let me read it back. ${readback}`, `Antes de hacerlo, déjeme repetirlo. ${readback}`), data: { stage: 'read_back' } };
  }
  // Per call and per identity class per day: a caller cannot hide (or, by hiding, walk through) the whole lead list.
  const rl = await rateLimit(`owner-reply:handled:${call.id}`, OWNER_REPLY_HANDLED_PER_CALL, 3600_000, { failClosed: true });
  if (!rl.allowed || !(await reserveHandled(business.id, trust))) {
    return fail(lang, 'That is the limit of customers I can mark as handled from this line. Please use the dashboard, or try again tomorrow.', 'Ese es el límite de clientes que puedo marcar como atendidos desde esta línea. Use el panel o intente mañana.');
  }
  await markHandled(business.id, lead.e164, trust);
  await auditReply('handled', business.id, null, { call: call.id, trust });
  return { ok: true, message: say(lang, 'Marked as handled. It will not be listed again.', 'Marcado como atendido. No volverá a aparecer en la lista.'), data: { stage: 'handled' } };
}

async function callback(g: Gate, args: Record<string, unknown>): Promise<OwnerToolResult> {
  const { business, call, lang } = g;
  const n = parseLeadRef(args.lead_ref);
  const lead = n ? await resolveLead(business, call, n) : null;
  if (!lead) return fail(lang, 'I do not have a customer with that number on this call. Let me list them first.', 'No tengo un cliente con ese número en esta llamada. Primero voy a leer la lista.');
  const sms = await rateLimit(`owner-callin:sms:${budgetOf(g)}`, OWNER_CONFIRM_SMS_PER_HOUR, 3600_000, { failClosed: true });
  if (!sms.allowed) return fail(lang, 'I have sent too many texts this hour. Please try again later.', 'He enviado demasiados mensajes esta hora. Intente más tarde.');
  // To the verified owner phone only (alertOwner); the number is never spoken.
  const text = say(lang, `Call back ${lead.name ?? 'the customer'}: ${lead.e164}`, `Devuelva la llamada a ${lead.name ?? 'el cliente'}: ${lead.e164}`);
  const sent = await alertOwner(business, text, { class: 'notice' });
  await auditReply('callback_sent', business.id, null, { call: call.id, texted: sent.notified, last4: last4Of(lead.e164) });
  if (!sent.notified) return fail(lang, 'I could not text the number to your phone.', 'No pude enviar el número a su teléfono.');
  return { ok: true, message: say(lang, 'I texted the callback number to your phone. I did not send anything to the customer.', 'Le envié el número a su teléfono. No envié nada al cliente.'), data: { stage: 'callback' } };
}

export async function runReplyTool(tool: OwnerReplyToolName, g: Gate, args: Record<string, unknown>): Promise<OwnerToolResult> {
  const blocked = await precheck(g);
  if (blocked) return blocked;
  if (tool === 'list_recent_leads') return listLeads(g);
  if (tool === 'draft_reply') return draft(g, args);
  if (tool === 'mark_lead_handled') return handled(g, args);
  return callback(g, args);
}
