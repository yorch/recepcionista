'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { useApi } from '@/hooks/use-api';
import { LOCALES, type Locale } from '@/lib/i18n/core';
import { useT } from '@/lib/i18n/client';

/** Settings > Language: the person's own language (users.locale) and the business default (businesses.locale_default). */
export function LanguageSettings({ businessId, initialBusinessLocale }: { businessId: string; initialBusinessLocale: Locale }) {
  const t = useT();
  const router = useRouter();
  const { busy, call } = useApi();
  const [saved, setSaved] = useState<Locale>(initialBusinessLocale);
  const [value, setValue] = useState<Locale>(initialBusinessLocale);

  async function save() {
    const data = await call(`/api/businesses/${businessId}/settings`, { method: 'PATCH', body: { locale_default: value } }, { success: t('set.lang.businessSaved') });
    if (data !== undefined) { setSaved(value); router.refresh(); } else toast.dismiss();
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-[12px] font-medium text-white">{t('set.lang.mine')}</p>
        <p className="mt-1 text-xs text-dim">{t('lang.uiHint')}</p>
        <LocaleSwitcher className="mt-2" />
      </div>
      <div>
        <label htmlFor="business-locale" className="block text-[12px] font-medium text-white">{t('lang.businessLabel')}</label>
        <select
          id="business-locale" value={value} onChange={(e) => setValue(e.target.value as Locale)} disabled={busy}
          className="mt-1.5 min-h-11 w-full max-w-xs rounded-xl border border-line-3 bg-sunken px-3 text-[15px] text-white sm:text-sm"
        >
          {LOCALES.map((l) => <option key={l} value={l} lang={l}>{l === 'en' ? t('common.english') : t('common.spanish')}</option>)}
        </select>
        <p className="mt-1.5 text-xs text-dim">{t('lang.businessHint')}</p>
        <div className="mt-3"><Button onClick={save} disabled={busy || value === saved}>{busy ? t('common.saving') : t('set.lang.saveBusiness')}</Button></div>
      </div>
    </div>
  );
}
