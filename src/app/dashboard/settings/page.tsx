import type { Metadata } from 'next';
import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { Card, CardHead } from '@/components/ui/card';
import { SettingsForm } from '@/components/dashboard/settings-form';
import { DEFAULT_DISCLOSURE, MAX_DISCLOSURE_LENGTH } from '@/lib/kb/disclosure';
import { tzOf } from '@/lib/time';
import Link from 'next/link';
import { CallHandlingSettings } from '@/components/dashboard/call-mode';
import { callModeView } from '@/lib/voice/call-mode';
import { VoiceSettingsCard } from '@/components/dashboard/voice-settings';
import { RefundPolicySettings } from '@/components/dashboard/refund-policy-settings';
import { GoogleCalendarCard } from '@/components/dashboard/google-calendar-card';
import { VerticalSettings } from '@/components/dashboard/vertical-settings';

export const metadata: Metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ gcal?: string }> }) {
  const { gcal } = await searchParams;
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'owner');
  const biz = ctx.business;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Settings</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">
          Call handling, what the receptionist says about recording, and how long customer data is kept.
        </p>
      </header>

      <Card className="mt-6">
        <CardHead title="Your alert phone" subtitle="Emergency, hand-off and payment texts go only to a number you have verified" />
        <div className="p-4 text-[13px] text-[#c4cedb]">
          {biz.owner_phone_verified_at ? (
            <p>{biz.owner_phone} is verified. Alerts go there.</p>
          ) : (
            <p>
              {biz.owner_phone ? `${biz.owner_phone} is not verified, so alerts are not sent to it. ` : 'No alert phone yet. '}
              <Link href="/onboarding?step=verify" className="font-semibold text-[#ffb08a] underline underline-offset-2">Verify your phone</Link>
            </p>
          )}
        </div>
      </Card>

      <Card className="mt-6" id="business-type">
        <CardHead title="Business type" subtitle="Which trade she is written for, including how she treats emergencies" />
        <div className="p-4"><VerticalSettings businessId={biz.id} initial={biz.vertical ?? 'hvac'} lang={biz.locale_default === 'es' ? 'es' : 'en'} /></div>
      </Card>

      <Card className="mt-6" id="call-handling-card">
        <CardHead title="Call handling" subtitle="Pause the assistant, or forward calls to a number you have verified" />
        <div className="p-4">
          <CallHandlingSettings
            businessId={biz.id}
            initial={callModeView(biz, { full: true })}
            ownerPhoneVerified={Boolean(biz.owner_phone_verified_at)}
            ownerPhone={biz.owner_phone ?? null}
          />
        </div>
      </Card>

      <Card className="mt-6" id="google-calendar">
        <CardHead title="Google Calendar" subtitle="Never double-book your own time, and see booked jobs in your calendar" />
        <div className="p-4"><GoogleCalendarCard initialResult={gcal ?? null} /></div>
      </Card>

      <Card className="mt-6" id="voice">
        <CardHead title="Assistant voice" subtitle="Pick how your receptionist sounds" />
        <div className="p-4"><VoiceSettingsCard businessId={biz.id} /></div>
      </Card>

      <Card className="mt-6" id="refund-policy">
        <CardHead title="Deposit refund policy" subtitle="What happens to a deposit when a booking is cancelled" />
        <div className="p-4">
          <RefundPolicySettings businessId={biz.id} initialPolicy={biz.refund_policy ?? 'full_24h'} initialText={biz.refund_policy_text ?? ''} />
        </div>
      </Card>

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
