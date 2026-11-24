/**
 * Billing notification emails to the business owner(s). Best effort: nothing here ever throws.
 */
import { listBusinessUsers } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email/templates';
import { returnBaseUrl } from '@/lib/providers/stripe-billing';
import { makeT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/core';
import { logger } from '@/lib/log';

const log = logger('billing.email');

export type BillingEmailKind = 'payment_failed' | 'trial_will_end' | 'canceled' | 'release_notice';

export interface BillingEmail { subject: string; text: string; html: string }

/** Pure: the message for `kind`. `link` is the billing page URL; `locale` the recipient's language. */
export function renderBillingEmail(kind: BillingEmailKind, opts: { businessName: string; link: string; trialEnd?: Date | null; releaseOn?: Date | null; locale?: Locale }): BillingEmail {
  const t = makeT(opts.locale ?? 'en');
  const business = opts.businessName;
  let subject: string;
  let lines: string[];
  let cta: string;
  if (kind === 'payment_failed') {
    subject = t('mail.bill.failed.subject');
    lines = [t('mail.bill.failed.l1', { business }), t('mail.bill.failed.l2')];
    cta = t('mail.bill.failed.cta');
  } else if (kind === 'trial_will_end') {
    const when = opts.trialEnd ? t('mail.bill.trial.on', { date: opts.trialEnd.toISOString().slice(0, 10) }) : t('mail.bill.trial.soon');
    subject = t('mail.bill.trial.subject');
    lines = [t('mail.bill.trial.l1', { business, when }), t('mail.bill.trial.l2')];
    cta = t('mail.bill.trial.cta');
  } else if (kind === 'release_notice') {
    const when = opts.releaseOn ? t('mail.bill.release.on', { date: opts.releaseOn.toISOString().slice(0, 10) }) : t('mail.bill.trial.soon');
    subject = t('mail.bill.release.subject');
    lines = [t('mail.bill.release.l1', { business }), t('mail.bill.release.l2', { business, when })];
    cta = t('mail.bill.release.cta');
  } else {
    subject = t('mail.bill.canceled.subject');
    lines = [t('mail.bill.canceled.l1', { business }), t('mail.bill.canceled.l2')];
    cta = t('mail.bill.canceled.cta');
  }
  const text = `${lines.join('\n\n')}\n\n${cta}: ${opts.link}\n`;
  const p = lines.map((x) => `<p style="margin:0 0 12px">${escapeHtml(x)}</p>`).join('');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">${p}`
    + `<p style="margin:16px 0"><a href="${escapeHtml(opts.link)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(cta)}</a></p></body></html>`;
  return { subject, text, html };
}

/** Email every active owner of the business. Returns how many were sent. Never throws. */
export async function notifyOwners(
  business: { id: string; name: string },
  kind: BillingEmailKind,
  opts: { trialEnd?: Date | null; releaseOn?: Date | null } = {},
): Promise<number> {
  try {
    const owners = (await listBusinessUsers(business.id)).filter((u) => u.role === 'owner' && !u.disabled_at);
    if (owners.length === 0) return 0;
    let sent = 0;
    for (const o of owners) {
      try {
        // Each owner gets the email in their own language.
        const msg = renderBillingEmail(kind, { businessName: business.name, link: `${returnBaseUrl()}/dashboard/billing`, trialEnd: opts.trialEnd, releaseOn: opts.releaseOn, locale: o.locale ?? 'en' });
        await sendEmail({ to: o.email, ...msg });
        sent++;
      } catch (err) {
        log.warn('send_failed', { business: business.id, kind, error: (err as Error).name });
      }
    }
    return sent;
  } catch (err) {
    log.warn('notify_failed', { business: business.id, kind, error: (err as Error).name });
    return 0;
  }
}
