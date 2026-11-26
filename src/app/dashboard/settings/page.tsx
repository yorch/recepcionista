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
import { DepositPolicySettings } from '@/components/dashboard/deposit-policy-settings';
import { DEPOSIT_MAX_CENTS, DEPOSIT_MIN_CENTS, depositPolicyOf } from '@/lib/business-config';
import { AI_DEPOSIT_CAP_CENTS } from '@/lib/payments/deposit';
import { GoogleCalendarCard } from '@/components/dashboard/google-calendar-card';
import { VerticalSettings } from '@/components/dashboard/vertical-settings';
import { ReviewUrlSettings } from '@/components/dashboard/review-url-settings';
import { PrivacyTools } from '@/components/dashboard/privacy-tools';
import { LineSettingsCard } from '@/components/dashboard/line-settings';
import { assistantNameOf, DEFAULT_ASSISTANT_NAME } from '@/lib/voice/assistant-name';
import { effectiveLineKindFor } from '@/lib/voice/line';
import { nativeTransferEnabled } from '@/lib/voice/transfer';
import { TimezoneSettings } from '@/components/dashboard/timezone-settings';
import { SchedulingSettings } from '@/components/dashboard/scheduling-settings';
import { schedulingOf } from '@/lib/business-config';
import { inferTimeZoneFromPhone } from '@/lib/tz-infer';

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

      <Card className="mt-6" id="ai-line">
        <CardHead title={t('line.card.title')} subtitle={t('line.card.sub')} />
        <div className="p-4">
          <LineSettingsCard
            businessId={biz.id}
            initial={{
              assistant_name: biz.assistant_name ?? null, assistant_name_effective: assistantNameOf(biz), default_assistant_name: DEFAULT_ASSISTANT_NAME,
              native_transfer_enabled: biz.native_transfer_enabled === true, transfer_capability: nativeTransferEnabled(), line_kind: effectiveLineKindFor(biz),
              own_line: Boolean(biz.elevenlabs_phone_number_id), has_number: Boolean(biz.phone),
              forward_number_verified: Boolean(biz.forward_number_e164 && (biz.forward_number_verified_at || (biz.owner_phone_verified_at && biz.owner_phone_e164 === biz.forward_number_e164))),
            }}
          />
        </div>
      </Card>

      <Card className="mt-6" id="review-link">
        <CardHead title={t('rv.title')} subtitle={t('rv.sub')} />
        <div className="p-4"><ReviewUrlSettings businessId={biz.id} initial={biz.review_url ?? ''} /></div>
      </Card>

      <Card className="mt-6" id="privacy">
        <CardHead title={t('pv.title')} subtitle={t('pv.sub')} />
        <div className="p-4"><PrivacyTools businessId={biz.id} /></div>
      </Card>

      <Card className="mt-6" id="time-zone">
        <CardHead title={t('pd.tz.title')} subtitle={t('pd.tz.sub')} />
        <div className="p-4"><TimezoneSettings businessId={biz.id} initial={{ timezone: tzOf(biz), suggested: inferTimeZoneFromPhone(biz.owner_phone_e164 ?? biz.owner_phone ?? null) }} /></div>
      </Card>

      <Card className="mt-6" id="scheduling">
        <CardHead title={t('pd.sc.title')} subtitle={t('pd.sc.sub')} />
        <div className="p-4"><SchedulingSettings businessId={biz.id} initial={schedulingOf(biz)} /></div>
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

      <Card className="mt-6" id="deposit-policy">
        <CardHead title={t('dp.title')} subtitle={t('dp.sub')} />
        <div className="p-4">
          <DepositPolicySettings
            businessId={biz.id} canEdit initial={depositPolicyOf(biz)}
            limits={{ min_cents: DEPOSIT_MIN_CENTS, max_cents: DEPOSIT_MAX_CENTS, ai_cap_cents: AI_DEPOSIT_CAP_CENTS }}
          />
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
