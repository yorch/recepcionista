/**
 * One-shot rollout helper for BILLING_ENFORCED=true: comps every EXISTING business so enforcing plans does not lock
 * current customers out (docs/billing.md, "Grandfather existing businesses").
 *
 *   bun scripts/grandfather-existing.ts            # dry run (default): prints what would change, writes nothing
 *   bun scripts/grandfather-existing.ts --apply    # does it
 *
 * For each business with billing_status 'none' and no Stripe subscription: billing_status 'active', plan 'legacy'.
 * Where an owner_phone is stored but not yet verified, owner_phone_verified_at is set (the number was already receiving
 * alerts, this keeps them flowing; owners can re-verify in Settings). Businesses that already have any billing state
 * (trialing, active, past_due, canceled, a Stripe subscription) are left alone. Idempotent; each change is audited.
 *
 * Guarded by the same safe-database check as seed/db-reset: pass --force-i-know to run against a database whose name is
 * not clearly disposable (a production rollout does need it). Always read the dry-run output first.
 */
import { disconnect, prisma, recordAudit } from '../src/lib/db';
import { assertSafeDatabase } from './_safe-db';

assertSafeDatabase('grandfather-existing');

const apply = process.argv.includes('--apply');

async function main() {
  const rows = await prisma.business.findMany({
    select: { id: true, name: true, billingStatus: true, stripeSubscriptionId: true, ownerPhone: true, ownerPhoneVerifiedAt: true },
    orderBy: { createdAt: 'asc' },
  });
  let comped = 0;
  let phones = 0;
  let skipped = 0;
  for (const b of rows) {
    const needsPlan = b.billingStatus === 'none' && !b.stripeSubscriptionId;
    const needsPhone = Boolean(b.ownerPhone) && !b.ownerPhoneVerifiedAt;
    if (!needsPlan && !needsPhone) { skipped++; continue; }
    console.log(`${apply ? 'UPDATE' : 'would update'} ${b.id} "${b.name}": ${[needsPlan ? "billing_status none -> active, plan 'legacy'" : null, needsPhone ? 'owner phone -> verified' : null].filter(Boolean).join('; ')}`);
    if (needsPlan) comped++;
    if (needsPhone) phones++;
    if (!apply) continue;
    await prisma.business.update({
      where: { id: b.id },
      data: {
        ...(needsPlan ? { billingStatus: 'active', plan: 'legacy' } : {}),
        ...(needsPhone ? { ownerPhoneVerifiedAt: new Date() } : {}),
      },
    });
    await recordAudit({
      actor_kind: 'system', business_id: b.id, action: 'billing.grandfathered', target: `business:${b.id}`,
      meta: { comped: needsPlan, owner_phone_verified: needsPhone, script: 'grandfather-existing' },
    });
  }
  console.log(`\n${apply ? 'Applied' : 'DRY RUN (nothing written). Re-run with --apply'}: ${rows.length} businesses, ${comped} comped, ${phones} owner phones verified, ${skipped} untouched.`);
  await disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await disconnect().catch(() => undefined);
  process.exit(1);
});
