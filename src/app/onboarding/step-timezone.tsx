'use client';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { SelectField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { inferTimeZoneFromPhone } from '@/lib/tz-infer';
import { tzSelectOptions } from '@/lib/tz-options';
import type { TimeZoneView } from '@/app/api/businesses/[id]/timezone/route';

export interface TimeZoneFieldHandle {
  /** Save the chosen zone when it differs from the stored one. Resolves false (and shows the error) when the save failed. */
  flush: () => Promise<boolean>;
}

/**
 * Onboarding "Your time zone" field (verify step). The zone is PRE-SELECTED from the owner's phone area code when it is known, otherwise the
 * stored zone stays selected; nothing is written until the owner continues (flush), so what is saved is always what they saw. Editable list of US and Canada
 * zones (IANA names: daylight saving is automatic). Ambiguous area codes give no suggestion and the owner just picks.
 */
export const OnboardingTimeZone = forwardRef<TimeZoneFieldHandle, { businessId: string; phone: string | null }>(function OnboardingTimeZone({ businessId, phone }, ref) {
  const t = useT();
  const lang = useLocale();
  const [stored, setStored] = useState<string | null>(null);
  const [zone, setZone] = useState<string>('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggested = inferTimeZoneFromPhone(phone);

  useEffect(() => {
    let live = true;
    apiRequest<TimeZoneView>(`/api/businesses/${businessId}/timezone`).then((v) => {
      if (!live) return;
      setStored(v.timezone);
      setZone((z) => z || v.timezone);
    }).catch((err) => { if (live) setError(errorText(t, err)); });
    return () => { live = false; };
  }, [businessId, t]);

  // The suggestion pre-selects until the owner picks something themselves.
  useEffect(() => { if (stored && suggested && !touched) setZone(suggested); }, [stored, suggested, touched]);

  useImperativeHandle(ref, () => ({
    async flush() {
      if (!stored || !zone || zone === stored) return true;
      try {
        const res = await apiRequest<TimeZoneView>(`/api/businesses/${businessId}/timezone`, { method: 'PUT', body: { timezone: zone } });
        setStored(res.timezone);
        setError(null);
        return true;
      } catch (err) {
        setError(errorText(t, err));
        return false;
      }
    },
  }), [stored, zone, businessId, t]);

  if (!stored) return error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : <div className="skeleton h-16" aria-busy="true" />;
  const fromPhone = suggested !== null && zone === suggested && !touched;
  return (
    <div>
      <SelectField
        label={t('pd.tz.label')} value={zone} error={error} disabled={false}
        onChange={(e) => { setZone(e.target.value); setTouched(true); setError(null); }}
        hint={fromPhone ? t('pd.tz.fromPhone') : t('pd.tz.onbHint')}
      >
        {tzSelectOptions(stored, lang).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </SelectField>
    </div>
  );
});
