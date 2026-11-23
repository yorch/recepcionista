/**
 * Billing notification emails to the business owner(s). Best effort: nothing here ever throws.
 */
import { listBusinessUsers } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email/templates';
import { returnBaseUrl } from '@/lib/providers/stripe-billing';
import { logger } from '@/lib/log';

const log = logger('billing.email');

export type BillingEmailKind = 'payment_failed' | 'trial_will_end' | 'canceled' | 'release_notice';

export interface BillingEmail { subject: string; text: string; html: string }

/** Pure: the message for `kind`. `link` is the billing page URL. */
export function renderBillingEmail(kind: BillingEmailKind, opts: { businessName: string; link: string; trialEnd?: Date | null; releaseOn?: Date | null }): BillingEmail {
  let subject: string;
  let lines: string[];
  let cta: string;
  if (kind === 'payment_failed') {
    subject = 'Payment failed for your Recepcionista subscription';
    lines = [
      `We could not charge the card on file for ${opts.businessName}.`,
      'Your receptionist keeps working for a few days. Update your payment method to avoid an interruption.',
    ];
    cta = 'Update payment method';
  } else if (kind === 'trial_will_end') {
    const when = opts.trialEnd ? ` on ${opts.trialEnd.toISOString().slice(0, 10)}` : ' soon';
    subject = 'Your Recepcionista free trial ends soon';
    lines = [
      `The free trial for ${opts.businessName} ends${when}.`,
      'Your card will be charged when it ends. You can cancel any time before that from the billing page.',
    ];
    cta = 'Manage billing';
  } else if (kind === 'release_notice') {
    const when = opts.releaseOn ? ` on or after ${opts.releaseOn.toISOString().slice(0, 10)}` : ' soon';
    subject = 'Your Recepcionista phone number and agent will be released';
    lines = [
      `The subscription for ${opts.businessName} is no longer active, so calls and texts are paused.`,
      `Unless you resubscribe first, we will release the phone number and voice agent set up for ${opts.businessName}${when}. Released numbers cannot be recovered and a new subscription would get a new number.`,
    ];
    cta = 'Resubscribe';
  } else {
    subject = 'Your Recepcionista subscription was canceled';
    lines = [
      `The subscription for ${opts.businessName} is canceled, so calls and texts are paused.`,
      'You can resubscribe at any time from the billing page.',
    ];
    cta = 'Open billing';
  }
  const text = `${lines.join('\n\n')}\n\n${cta}: ${opts.link}\n`;
  const p = lines.map((t) => `<p style="margin:0 0 12px">${escapeHtml(t)}</p>`).join('');
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
    const msg = renderBillingEmail(kind, { businessName: business.name, link: `${returnBaseUrl()}/dashboard/billing`, trialEnd: opts.trialEnd, releaseOn: opts.releaseOn });
    let sent = 0;
    for (const o of owners) {
      try {
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
