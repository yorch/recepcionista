import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { Card, CardHead } from '@/components/ui/card';
import { SettingsForm } from '@/components/dashboard/settings-form';
import { DEFAULT_DISCLOSURE, MAX_DISCLOSURE_LENGTH } from '@/lib/kb/disclosure';
import { tzOf } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'owner');
  const biz = ctx.business;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Privacy and consent</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">
          What the receptionist says about recording, and how long customer data is kept.
        </p>
      </header>

      <Card className="mt-6">
        <CardHead title="Call disclosure and retention" subtitle={biz.name} />
        <div className="p-4">
          <SettingsForm
            businessId={biz.id}
            timezone={tzOf(biz)}
            initialRetentionDays={biz.retention_days ?? 365}
            initialDisclosure={biz.recording_disclosure_text ?? ''}
            defaultDisclosure={DEFAULT_DISCLOSURE}
            maxDisclosureLength={MAX_DISCLOSURE_LENGTH}
          />
        </div>
      </Card>

      <p className="mt-4 text-[11px] leading-relaxed text-[#5a6b80]">
        Have your own counsel review the disclosure wording for the states you serve. See docs/compliance.md.
      </p>
    </main>
  );
}
