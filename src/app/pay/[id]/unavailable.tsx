import { LogoMark } from '@/components/ui/logo';
import { formatPhoneDisplay, type TFunction } from '@/lib/i18n/core';

/**
 * Shown instead of any card form when this booking has no payable link (the link was cancelled, replaced, used, expired, or payments are not set up).
 * Honest and short: the business is the one who can fix it. Pure markup (no 'use client').
 */
export function PayUnavailable({ businessName, businessPhone, t }: { businessName: string; businessPhone?: string | null; t: TFunction }) {
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <LogoMark />
      <h1 className="mt-5 text-[24px] font-semibold tracking-[-0.02em] text-white">{t('pay.unavailable.title')}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-mute">{t('pay.unavailable.body', { business: businessName })}</p>
      {businessPhone ? (
        <a href={`tel:${businessPhone}`} className="mt-5 inline-flex min-h-11 items-center rounded-xl border border-line-3 px-5 text-[15px] font-medium text-white hover:bg-raised">
          {t('pay.unavailable.call', { phone: formatPhoneDisplay(businessPhone) })}
        </a>
      ) : null}
    </main>
  );
}
