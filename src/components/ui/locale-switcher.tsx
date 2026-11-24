'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { LOCALE_COOKIE, LOCALES, type Locale } from '@/lib/i18n/core';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/components/ui/cn';

/** Persist a language choice: users.locale when signed in (PATCH /api/me/locale) and the rc_locale cookie for everyone. */
export async function saveLocale(locale: Locale): Promise<boolean> {
  try {
    const res = await fetch('/api/me/locale', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale }) });
    // 401/403 = not signed in (public pages): the cookie below is the whole persistence there.
    if (!res.ok && res.status !== 401 && res.status !== 403) return false;
  } catch {
    return false;
  }
  try {
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax${window.location.protocol === 'https:' ? '; secure' : ''}`;
  } catch { /* cookies blocked */ }
  return true;
}

/** Two-button language switcher (EN | ES). `compact` renders it inline for footers. */
export function LocaleSwitcher({ className, compact = false, onChanged }: { className?: string; compact?: boolean; onChanged?: (locale: Locale) => void | Promise<void> }) {
  const current = useLocale();
  const t = useT();
  const [busy, setBusy] = useState(false);

  async function choose(next: Locale) {
    if (next === current || busy) return;
    setBusy(true);
    const ok = await saveLocale(next);
    setBusy(false);
    if (!ok) { toast.error(t('lang.switchFailed')); return; }
    await onChanged?.(next);
    // A full reload re-renders every server component, the html lang and the client catalog in the new language.
    window.location.reload();
  }

  return (
    <div role="group" aria-label={t('lang.switcherLabel')} className={cn('inline-flex items-center gap-1', className)}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === current}
          disabled={busy}
          onClick={() => void choose(l)}
          className={cn(
            'min-h-8 rounded-md px-2.5 text-[12px] font-medium transition-colors',
            l === current ? 'bg-[#1b2430] text-white' : 'text-[#8b98ab] hover:text-white',
          )}
        >
          {compact ? l.toUpperCase() : l === 'en' ? 'English' : 'Español'}
        </button>
      ))}
    </div>
  );
}
