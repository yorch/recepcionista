/**
 * What happens AFTER a call handling change (mode or forwarding target), shared by every route that can make one:
 *  - one audit row per mode TRANSITION, including the implicit ones (a new number dropping 'forward' back to 'ai', removing the
 *    number) with the reason, so the trail never has a silent mode change;
 *  - the owner is told by email (every active owner) AND by text (the verified owner phone), rate limited per business, because a
 *    stolen session redirecting the business line is the worst thing this feature can be used for. The notice never contains the
 *    full number, only its last four digits. Notification failures never fail the change and never throw.
 */
import { listBusinessUsers, recordAudit } from '@/lib/db';
import type { CallModeChange } from '@/lib/db/call-mode';
import { sendEmail } from '@/lib/email';
import { appBaseUrl, escapeHtml, safeDisplayName } from '@/lib/email/templates';
import { rateLimit } from '@/lib/ratelimit';
import { auditActorOf, type Principal } from '@/lib/session';
import { alertOwner } from '@/lib/voice/owner-alert';
import { logger } from '@/lib/log';
import { makeT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/core';
import { ownerLocaleFor } from '@/lib/i18n/owner-locale';
import type { Business } from '@/lib/types';

const log = logger('voice/call-handling');

/** Notices per business per hour, per channel. Past it the change still happens and is audited; only the extra notices are held back. */
export const CHANGE_NOTICES_PER_HOUR = 6;

export interface ChangeActor { actor_kind: 'user' | 'admin_token'; actor_user_id: string | null; email?: string | null; /** Role and how the credential authenticated: audit meta only. */ meta?: Record<string, unknown> }

/** The audit/notice actor of an authenticated request. */
export function actorOf(auth: { principal: Principal }): ChangeActor {
  const a = auditActorOf(auth.principal);
  return { actor_kind: a.actor_kind, actor_user_id: a.actor_user_id, email: auth.principal.user?.email ?? null, meta: a.meta };
}

const MODE_WORD = { en: { ai: 'AI answers', paused: 'paused', forward: 'forwarding' }, es: { ai: 'contesta la IA', paused: 'en pausa', forward: 'desvío' } } as const;
const last4 = (n: string | null): string => (n ? n.slice(-4) : '');

/** The plain-text facts of a change, for the email and the text. Pure. */
export function changeSummary(change: CallModeChange, reason: string, locale: Locale = 'en'): { modeChanged: boolean; targetChanged: boolean; line: string } {
  const es = locale === 'es';
  const W = MODE_WORD[locale];
  const { before, after } = change;
  const modeChanged = before.call_mode !== after.call_mode;
  const targetChanged = before.forward_number_e164 !== after.forward_number_e164
    || (before.forward_number_verified_at === null) !== (after.forward_number_verified_at === null);
  const parts: string[] = [];
  if (modeChanged) parts.push(es ? `el manejo de llamadas cambió de ${W[before.call_mode]} a ${W[after.call_mode]}` : `call handling changed from ${W[before.call_mode]} to ${W[after.call_mode]}`);
  if (targetChanged) {
    parts.push(after.forward_number_e164
      ? (es
        ? `el número de desvío ${after.forward_number_verified_at ? 'se estableció en' : 'cambió (aún sin verificar) a'} el número que termina en ${last4(after.forward_number_e164)}`
        : `forwarding number ${after.forward_number_verified_at ? 'set to' : 'changed (not yet verified) to'} the number ending ${last4(after.forward_number_e164)}`)
      : (es ? 'se quitó el número de desvío' : 'forwarding number removed'));
  }
  return { modeChanged, targetChanged, line: `${parts.join('; ')} (${reason})` };
}

/**
 * Audit and announce a change. `reason` is a short machine-ish label ('mode_changed', 'forward_number_verified',
 * 'forward_number_replaced', 'forward_number_removed', ...). Returns what was announced (for tests and logs).
 */
export async function announceCallHandlingChange(opts: {
  business: Business;
  actor: ChangeActor;
  ip: string | null;
  change: CallModeChange;
  reason: string;
}): Promise<{ audited: boolean; email: number; sms: boolean; suppressed: boolean }> {
  const { business, actor, ip, change, reason } = opts;
  const sum = changeSummary(change, reason, 'en');
  const out = { audited: false, email: 0, sms: false, suppressed: false };
  if (sum.modeChanged) {
    out.audited = await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: business.id, action: 'business.call_mode_changed',
      target: `business:${business.id}`, ip,
      meta: { ...actor.meta, from: change.before.call_mode, to: change.after.call_mode, reason, forward_during_hours: change.after.forward_during_hours, forward_last4: last4(change.after.forward_number_e164) },
    });
  }
  if (!sum.modeChanged && !sum.targetChanged) return out;

  try {
    const actorName = actor.email ? actor.email.replace(/[^\w.+@-]/g, '').slice(0, 60) : '';
    const ownerEmails = (await listBusinessUsers(business.id)).filter((u) => u.role === 'owner' && !u.disabled_at);
    const emailOk = (await rateLimit(`callmode-notice:email:${business.id}`, CHANGE_NOTICES_PER_HOUR, 60 * 60_000)).allowed;
    const smsOk = (await rateLimit(`callmode-notice:sms:${business.id}`, CHANGE_NOTICES_PER_HOUR, 60 * 60_000)).allowed;
    if (!emailOk || !smsOk) { out.suppressed = true; log.warn('change_notice_suppressed', { business: business.id, email: !emailOk, sms: !smsOk }); }

    if (emailOk) {
      const link = `${appBaseUrl()}/dashboard/settings#call-handling`;
      for (const o of ownerEmails) {
        // Each owner reads it in their own language.
        const t = makeT(o.locale ?? 'en');
        const lines = [
          t('mail.callChange.l1', { business: safeDisplayName(business.name, 60, o.locale ?? 'en'), who: actorName ? t('mail.callChange.who', { who: actorName }) : '', line: changeSummary(change, reason, o.locale ?? 'en').line }),
          t('mail.callChange.l2'),
        ];
        const text = `${lines.join('\n\n')}\n\n${link}\n`;
        const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">${lines.map((x) => `<p style="margin:0 0 12px">${escapeHtml(x)}</p>`).join('')}`
          + `<p style="margin:16px 0"><a href="${escapeHtml(link)}">${escapeHtml(t('mail.callChange.cta'))}</a></p></body></html>`;
        try { await sendEmail({ to: o.email, subject: t('mail.callChange.subject'), text, html }); out.email++; } catch (err) { log.warn('change_email_failed', { business: business.id, error: (err as Error).name }); }
      }
    }
    if (smsOk) {
      const locale = await ownerLocaleFor(business);
      const t = makeT(locale);
      const res = await alertOwner(business, t('mail.callChange.sms', { business: safeDisplayName(business.name, 30, locale), line: changeSummary(change, reason, locale).line, who: actorName ? ` ${t('mail.callChange.who', { who: actorName }).trim()}` : '' }));
      out.sms = res.notified;
    }
  } catch (err) {
    log.error('change_notice_failed', { business: business.id, err });
  }
  return out;
}
