/**
 * One-shot rollout helper for plan enforcement: comps EXISTING, vetted businesses so enforcing plans does not lock
 * current customers out (docs/billing.md, "Grandfather existing businesses").
 *
 *   bun scripts/grandfather-existing.ts --before 2026-11-25T00:00:00Z            # dry run (default): lists, writes nothing
 *   bun scripts/grandfather-existing.ts --before 2026-11-25T00:00:00Z --apply    # comps the listed businesses
 *
 * Safety rules (this gives away paid service, so it is deliberately narrow):
 *  - `--before <ISO instant>` is REQUIRED with --apply: only businesses created before it are touched (use the moment
 *    signup went live / the deploy time). Anything created later, or by anyone who signed up since, is never comped.
 *  - Skipped: businesses whose owner has no verified email, self-signup businesses (an `auth.signup` audit row;
 *    override with --include-self-signup, only after reviewing the list), and businesses with an owner phone that is not
 *    verified (override with --include-unverified-phone).
 *  - It NEVER marks an owner phone verified. Owners verify in Settings; for a legacy tenant who cannot, use
 *    OWNER_PHONE_GRANDFATHER (docs/runbook.md) as an explicit, acknowledged, time-boxed decision.
 *  - Businesses with any billing state (trialing, active, past_due, canceled, a Stripe subscription) are left alone.
 *    Idempotent; each change is audited. The selected list is always printed first: read it.
 *
 * Guarded by the same safe-database check as seed/db-reset: pass --force-i-know to run against a database whose name is
 * not clearly disposable (a production rollout does need it). Always read the dry-run output first.
 */
import { disconnect, recordAudit } from '../src/lib/db';
import { compBusiness, planGrandfather } from '../src/lib/billing/grandfather';
import { assertSafeDatabase } from './_safe-db';

assertSafeDatabase('grandfather-existing');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeUnverifiedPhone = args.includes('--include-unverified-phone');
const includeSelfSignup = args.includes('--include-self-signup');
const beforeIdx = args.indexOf('--before');
const beforeRaw = beforeIdx >= 0 ? args[beforeIdx + 1] : undefined;

function usageExit(msg: string): never {
  console.error(`[grandfather-existing] ${msg}`);
  console.error('usage: bun scripts/grandfather-existing.ts --before <ISO instant> [--apply] [--include-unverified-phone] [--include-self-signup] [--force-i-know]');
  process.exit(2);
}

async function main() {
  if (apply && !beforeRaw) usageExit('--before <ISO instant> is required with --apply');
  const cutoff = beforeRaw ? new Date(beforeRaw) : null;
  if (beforeRaw && (!cutoff || Number.isNaN(cutoff.getTime()))) usageExit(`--before "${beforeRaw}" is not a valid ISO date`);
  // The same switch as the admin jobs (src/lib/jobs/tenants.ts): a real run needs TENANT_RELEASE_JOB=on. Without --apply this is a dry run.
  if (apply && (process.env.TENANT_RELEASE_JOB ?? '').trim().toLowerCase() !== 'on') {
    console.error('[grandfather-existing] --apply is refused: set TENANT_RELEASE_JOB=on to allow real releases / comps (the dry run needs nothing).');
    process.exit(2);
  }
  if (!cutoff) {
    console.warn('No --before given: nothing will be selected (a cutoff is required to comp anyone). Showing the reasons only.\n');
  }
  const plan = await planGrandfather({ cutoff: cutoff ?? new Date(0), includeUnverifiedPhone, includeSelfSignup });

  console.log(`Cutoff: ${cutoff ? cutoff.toISOString() : '(none)'}; include unverified phone: ${includeUnverifiedPhone}; include self-signup: ${includeSelfSignup}\n`);
  console.log(`ELIGIBLE (${plan.eligible.length}):`);
  for (const b of plan.eligible) {
    console.log(`  ${b.id} "${b.name}" created ${b.createdAt.toISOString()} owners ${b.ownerEmails.join(', ')} phone ${b.ownerPhone ? (b.ownerPhoneVerified ? 'verified' : 'UNVERIFIED (left unverified)') : 'none'}`);
  }
  console.log(`\nSKIPPED (${plan.skipped.length}):`);
  for (const s of plan.skipped) console.log(`  ${s.id} "${s.name}": ${s.reason}`);

  let comped = 0;
  if (apply) {
    for (const b of plan.eligible) {
      if (!(await compBusiness(b.id))) continue;
      comped++;
      await recordAudit({
        actor_kind: 'system', business_id: b.id, action: 'billing.grandfathered', target: `business:${b.id}`,
        meta: { script: 'grandfather-existing', cutoff: cutoff!.toISOString(), owner_phone_verified: b.ownerPhoneVerified },
      });
    }
  }
  console.log(`\n${apply ? `Applied: ${comped} comped` : 'DRY RUN (nothing written). Re-run with --apply after reading the list above'}; owner phones are never marked verified by this script.`);
  await disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await disconnect().catch(() => undefined);
  process.exit(1);
});
