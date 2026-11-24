import type { Metadata } from 'next';
import { getLocale, getT } from '@/lib/i18n/server';
import { formatPhoneDisplay } from '@/lib/i18n/core';
import { LanguageSettings } from '@/components/dashboard/language-settings';
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

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('set.metaTitle') };
}

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ gcal?: string }> }) {
  const t = await getT();
  const locale = await getLocale();
  const { gcal } = await searchParams;
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'owner');
  const biz = ctx.business;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{t('set.title')}</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">
          {t('set.subtitle')}
        </p>
      </header>

      <Card className="mt-6">
        <CardHead title={t('set.alert.title')} subtitle={t('set.alert.sub')} />
        <div className="p-4 text-[13px] text-[#c4cedb]">
          {biz.owner_phone_verified_at ? (
            <p>{t('set.alert.verified', { phone: formatPhoneDisplay(biz.owner_phone) })}</p>
          ) : (
            <p>
              {biz.owner_phone ? `${t('set.alert.unverified', { phone: formatPhoneDisplay(biz.owner_phone) })} ` : `${t('set.alert.none')} `}
              <Link href="/onboarding?step=verify" className="font-semibold text-[#ffb08a] underline underline-offset-2">{t('set.alert.verify')}</Link>
            </p>
          )}
        </div>
      </Card>

      <Card className="mt-6" id="language">
        <CardHead title={t('set.lang.title')} subtitle={t('set.lang.sub')} />
        <div className="p-4"><LanguageSettings businessId={biz.id} initialBusinessLocale={biz.locale_default === 'es' ? 'es' : 'en'} /></div>
      </Card>
      <Card className="mt-6" id="business-type">
        <CardHead title={t('set.type.title')} subtitle={t('set.type.sub')} />
        <div className="p-4"><VerticalSettings businessId={biz.id} initial={biz.vertical ?? 'hvac'} lang={locale} /></div>
      </Card>

      <Card className="mt-6" id="call-handling-card">
        <CardHead title={t('set.calls.title')} subtitle={t('set.calls.sub')} />
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
        <CardHead title={t('set.gcal.title')} subtitle={t('set.gcal.sub')} />
        <div className="p-4"><GoogleCalendarCard initialResult={gcal ?? null} /></div>
      </Card>

      <Card className="mt-6" id="voice">
        <CardHead title={t('set.voice.title')} subtitle={t('set.voice.sub')} />
        <div className="p-4"><VoiceSettingsCard businessId={biz.id} /></div>
      </Card>

      <Card className="mt-6" id="refund-policy">
        <CardHead title={t('set.refund.title')} subtitle={t('set.refund.sub')} />
        <div className="p-4">
          <RefundPolicySettings businessId={biz.id} initialPolicy={biz.refund_policy ?? 'full_24h'} initialText={biz.refund_policy_text ?? ''} />
        </div>
      </Card>

      <Card className="mt-6">
        <CardHead title={t('set.disc.title')} subtitle={biz.name} />
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
        {t('set.disc.footer')}
      </p>
    </main>
  );
}
