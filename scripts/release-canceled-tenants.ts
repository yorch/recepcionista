/**
 * Release the provider resources (Twilio number, ElevenLabs agent and tools) of tenants that stopped paying
 * (docs/billing.md "Releasing canceled tenants", docs/runbook.md).
 *
 *   bun scripts/release-canceled-tenants.ts                      # DRY RUN (default): prints what would happen, writes/calls nothing
 *   bun scripts/release-canceled-tenants.ts --apply              # sends the heads-up mails and releases what is due
 *
 * Options:
 *   --grace-days N     days after billing_status canceled/unpaid and the end of the paid period before release (default 30)
 *   --notify-days N    heads-up e-mail lead time: owners are mailed N days before the release date and the release waits at
 *                      least N days after the mail (default 7; 0 = no heads-up). Run it daily (cron): the mail is sent once
 *                      (audit `billing.release_notice`, meta.notified_at), the release happens on a later run.
 *   --include-recent   also consider businesses with calls in the last 7 days (skipped by default)
 *   --business <id>    only this business
 *   --force-i-know     required when DATABASE_URL does not look disposable (a production run needs it)
 *
 * Never released: admin-comped plans, trialing/active/past_due/none businesses, a number or agent shared with another
 * business, the platform SMS number (TWILIO_PHONE_NUMBER). Provider calls are idempotent (404 = already gone) and a
 * failure leaves the database reference in place so the next run retries. Audited: billing.release_notice, billing.tenant_released.
 */
import { disconnect } from '../src/lib/db';
import { DEFAULT_GRACE_DAYS, DEFAULT_NOTIFY_DAYS, listReleaseCandidates, processBusiness, type BusinessReport } from '../src/lib/billing/release';
import { assertSafeDatabase } from './_safe-db';

assertSafeDatabase('release-canceled-tenants');

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
function intArg(name: string, dflt: number): number {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 0 || n > 3650) usageExit(`${name} needs an integer between 0 and 3650`);
  return n;
}
function usageExit(msg: string): never {
  console.error(`[release-canceled-tenants] ${msg}`);
  console.error('usage: bun scripts/release-canceled-tenants.ts [--apply] [--grace-days N] [--notify-days N] [--include-recent] [--business <id>] [--force-i-know]');
  process.exit(2);
}

const line = (r: BusinessReport): string => {
  const d = r.decision;
  const what = d.action === 'skip' ? `SKIP     ${d.reason}`
    : d.action === 'wait' ? `WAIT     ${d.reason} (until ${d.until.toISOString().slice(0, 10)})`
      : d.action === 'notify' ? `NOTIFY   heads-up e-mail to the owners; release on/after ${d.release_on.toISOString().slice(0, 10)}`
        : `RELEASE  number + agent (notice: ${d.notice})`;
  const done = r.error ? `  !! ${r.error}` : r.applied ? `  -> done${r.notified !== undefined ? ` (${r.notified} mail(s))` : ''}` : '';
  const out = r.outcome ? `\n      ${JSON.stringify({ number: r.outcome.number.result, agent: r.outcome.agent.result, tools: r.outcome.tools, cleared: r.outcome.cleared, errors: r.outcome.errors })}` : '';
  return `  ${r.id} "${r.name}": ${what}${done}${out}`;
};

async function main() {
  const apply = flag('--apply');
  const graceDays = intArg('--grace-days', DEFAULT_GRACE_DAYS);
  const notifyDays = intArg('--notify-days', DEFAULT_NOTIFY_DAYS);
  const includeRecent = flag('--include-recent');
  const bi = args.indexOf('--business');
  const only = bi >= 0 ? args[bi + 1] : undefined;
  if (bi >= 0 && !only) usageExit('--business needs an id');
  console.log(`grace ${graceDays} days, notify ${notifyDays} days, include recent: ${includeRecent}; mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  const ids = only ? [only] : await listReleaseCandidates();
  let acted = 0;
  let failed = 0;
  console.log(`Candidates (billing canceled/unpaid): ${ids.length}`);
  for (const id of ids) {
    const r = await processBusiness(id, { apply, graceDays, notifyDays, includeRecent, actor: { kind: 'system' }, script: 'release-canceled-tenants' });
    if (!r) { console.log(`  ${id}: not found`); continue; }
    console.log(line(r));
    if (r.applied) acted++;
    if (r.error || (r.outcome && r.outcome.errors.length)) failed++;
  }
  console.log(apply ? `\nApplied: ${acted} acted, ${failed} with errors (retry on the next run).` : '\nDRY RUN: nothing was sent, released or written. Re-run with --apply after reading the list above.');
  await disconnect();
  if (failed) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await disconnect().catch(() => undefined);
  process.exit(1);
});
