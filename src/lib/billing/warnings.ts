/**
 * Cap warnings: when SMS / AI call minutes / forwarded minutes cross 80% and 100% of the month's cap, the owner gets exactly ONE email
 * and ONE text per kind per level per period. "Exactly once" is a database claim (`markWarned`: a single UPDATE .. WHERE col IS NULL), so
 * concurrent requests, jobs and instances send one. A warning that could not be delivered anywhere gives its claim back (`unmarkWarned`)
 * and is retried by the safety-net job. The text goes only to a VERIFIED owner phone, never in quiet hours (9pm-8am local: the warning
 * is simply attempted again later), through the owner-alert channel (its own rate limit, NOT counted against the SMS cap).
 * A new month is a new usage row, so warnings re-arm themselves.
 */
import {
  billingEnforced, callMinutesCapFor, forwardMinutesCapFor, getBusiness, getUsage, getUsageWarnings, listBusinessUsers, markWarned, smsCapFor,
  unmarkWarned, usagePercent,
} from '@/lib/db';
import type { UsageWarnings, WarnKind, WarnLevel } from '@/lib/db/usage';
import { sendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email/templates';
import { inQuietHours } from '@/lib/jobs/schedule';
import { logger } from '@/lib/log';
import { ownerAlertStatus } from '@/lib/messaging/owner';
import { returnBaseUrl } from '@/lib/providers/stripe-billing';
import { alertOwner } from '@/lib/voice/owner-alert';
import type { Business } from '@/lib/types';

const log = logger('billing/warnings');

export const WARN_KINDS: readonly WarnKind[] = ['sms', 'ai', 'forward'];
export const WARN_LEVELS: readonly WarnLevel[] = [80, 100];

export interface UsageLine { kind: WarnKind; used: number; cap: number; percent: number; unit: 'texts' | 'minutes' }

const LABEL: Record<WarnKind, { en: string; unit: 'texts' | 'minutes' }> = {
  sms: { en: 'text messages', unit: 'texts' }, ai: { en: 'AI call minutes', unit: 'minutes' }, forward: { en: 'forwarded call minutes', unit: 'minutes' },
};

/** Current usage as a percent of each cap (pure given the inputs). Caps of 0 yield 100 when anything was used. */
export function usageLines(
  business: Pick<Business, 'billing_status'> & { sms_cap_override?: number | null; call_minutes_cap_override?: number | null },
  usage: { sms_count: number; call_seconds: number; forward_seconds: number }, env: NodeJS.ProcessEnv = process.env,
): UsageLine[] {
  const sms = smsCapFor(business, env);
  const ai = callMinutesCapFor(business, env) * 60;
  const fw = forwardMinutesCapFor(business, env) * 60;
  const line = (kind: WarnKind, used: number, cap: number): UsageLine => ({
    kind, used: LABEL[kind].unit === 'texts' ? used : Math.round(used / 60), cap: LABEL[kind].unit === 'texts' ? cap : Math.round(cap / 60),
    percent: usagePercent(used, cap), unit: LABEL[kind].unit,
  });
  return [line('sms', usage.sms_count, sms), line('ai', usage.call_seconds, ai), line('forward', usage.forward_seconds, fw)];
}

export interface PendingWarning { kind: WarnKind; level: WarnLevel; used: number; cap: number; percent: number; unit: 'texts' | 'minutes' }

/** The warnings that are due but not yet sent: the highest crossed level per kind (80 is skipped, silently claimed, when 100 is already crossed). */
export function dueWarnings(lines: UsageLine[], sent: UsageWarnings | null): PendingWarning[] {
  const out: PendingWarning[] = [];
  for (const l of lines) {
    const level: WarnLevel | null = l.percent >= 100 ? 100 : l.percent >= 80 ? 80 : null;
    if (!level) continue;
    if (sent && sent[`${l.kind}_${level}`]) continue;
    out.push({ kind: l.kind, level, used: l.used, cap: l.cap, percent: l.percent, unit: l.unit });
  }
  return out;
}

export function warningMessage(w: Pick<PendingWarning, 'kind' | 'level' | 'used' | 'cap' | 'unit'>, businessName: string): { sms: string; subject: string; text: string } {
  const what = LABEL[w.kind].en;
  const amount = `${w.used} of ${w.cap} ${w.unit === 'texts' ? 'texts' : 'minutes'}`;
  const tail = w.level === 100
    ? (w.kind === 'forward' ? 'Forwarded calls now go to voicemail until the next period.' : w.kind === 'ai' ? 'The assistant cannot take more calls until the next period or a plan change.' : 'Customer texts are paused until the next period or a plan change.')
    : 'Nothing stops yet; at 100% the limit applies.';
  const head = w.level === 100 ? `You have used all of your ${what}` : `You have used 80% of your ${what}`;
  return {
    sms: `${businessName}: ${head} this month (${amount}). ${tail} Billing: ${returnBaseUrl()}/dashboard/billing`,
    subject: w.level === 100 ? `Limit reached: ${what} (${businessName})` : `80% of your ${what} used (${businessName})`,
    text: `${head} this month for ${businessName} (${amount}).\n\n${tail}\n\nSee usage and plans: ${returnBaseUrl()}/dashboard/billing\n`,
  };
}

export interface WarningDeps {
  now?: () => Date;
  sendEmail?: (to: string, subject: string, text: string, html: string) => Promise<void>;
  sendSms?: (business: Business, body: string) => Promise<boolean>;
  ownerEmails?: (businessId: string) => Promise<string[]>;
}

const defaultDeps: Required<Omit<WarningDeps, 'now'>> = {
  sendEmail: async (to, subject, text, html) => { await sendEmail({ to, subject, text, html }); },
  sendSms: async (b, body) => (await alertOwner(b, body)).notified,
  ownerEmails: async (id) => (await listBusinessUsers(id)).filter((u) => u.role === 'owner' && !u.disabled_at).map((u) => u.email),
};

export interface WarningResult { kind: WarnKind; level: WarnLevel; outcome: 'sent' | 'already_sent' | 'deferred_quiet_hours' | 'failed' | 'skipped_not_due'; email: number; sms: boolean }

/**
 * Send whatever warnings are due for one business (idempotent, safe to call on every usage write). Never throws.
 * Only meaningful when billing is enforced (a dev / demo install has no real caps): returns [] otherwise unless `force`.
 */
export async function checkUsageWarnings(businessId: string, deps: WarningDeps = {}, opts: { force?: boolean } = {}): Promise<WarningResult[]> {
  const d = { ...defaultDeps, ...deps };
  const now = (deps.now ?? (() => new Date()))();
  const results: WarningResult[] = [];
  try {
    if (!opts.force && !billingEnforced()) return results;
    const [business, usage, sent] = await Promise.all([getBusiness(businessId), getUsage(businessId, now), getUsageWarnings(businessId, now)]);
    if (!business || !usage) return results;
    const due = dueWarnings(usageLines(business, usage), sent);
    for (const w of due) {
      // A single day's jump straight to 100% also uses up the 80% warning: silently claim it so it never fires later.
      if (w.level === 100) await markWarned(businessId, w.kind, 80, now).catch(() => false);
      const quiet = inQuietHours(now, business.timezone);
      if (quiet && ownerAlertStatus(business) === 'ok') { results.push({ kind: w.kind, level: w.level, outcome: 'deferred_quiet_hours', email: 0, sms: false }); continue; }
      if (!(await markWarned(businessId, w.kind, w.level, now))) { results.push({ kind: w.kind, level: w.level, outcome: 'already_sent', email: 0, sms: false }); continue; }
      const msg = warningMessage(w, business.name);
      let emails = 0;
      let sms = false;
      try {
        for (const to of await d.ownerEmails(businessId)) {
          try {
            await d.sendEmail(to, msg.subject, msg.text, `<!doctype html><html><body style="font-family:system-ui,sans-serif">${msg.text.split('\n\n').map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</body></html>`);
            emails++;
          } catch (err) { log.warn('email_failed', { business: businessId, kind: w.kind, err: (err as Error).name }); }
        }
        if (ownerAlertStatus(business) === 'ok') sms = await d.sendSms(business, msg.sms);
      } catch (err) { log.warn('send_error', { business: businessId, err }); }
      if (emails === 0 && !sms) {
        await unmarkWarned(businessId, w.kind, w.level, now); // nothing went out anywhere: try again on the next pass
        results.push({ kind: w.kind, level: w.level, outcome: 'failed', email: 0, sms: false });
      } else {
        log.info('usage_warning_sent', { business: businessId, kind: w.kind, level: w.level, emails, sms });
        results.push({ kind: w.kind, level: w.level, outcome: 'sent', email: emails, sms });
      }
    }
  } catch (err) {
    log.error('check_failed', { business: businessId, err });
  }
  return results;
}

/** Fire-and-forget form for the usage-recording call sites: never delays or fails the caller. */
export function triggerUsageWarnings(businessId: string): void {
  void checkUsageWarnings(businessId).catch(() => undefined);
}

export interface UsageWarningView extends UsageLine { level: 80 | 100; label: string; sent_at: string | null }

/**
 * Pure-ish helper for the billing status API (`warnings` field) and the banner: the kinds currently at or above 80%, with their level and
 * whether the owner was already notified. Never throws (empty list on failure).
 */
export async function usageWarningsFor(businessId: string, now: Date = new Date()): Promise<UsageWarningView[]> {
  try {
    const [business, usage, sent] = await Promise.all([getBusiness(businessId), getUsage(businessId, now), getUsageWarnings(businessId, now)]);
    if (!business || !usage) return [];
    return usageLines(business, usage).filter((l) => l.percent >= 80).map((l) => {
      const level: 80 | 100 = l.percent >= 100 ? 100 : 80;
      return { ...l, level, label: LABEL[l.kind].en, sent_at: sent?.[`${l.kind}_${level}`] ?? null };
    });
  } catch (err) {
    log.warn('warnings_for_failed', { business: businessId, err });
    return [];
  }
}
