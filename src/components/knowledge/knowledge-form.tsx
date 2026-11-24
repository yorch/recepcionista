'use client';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { useLocale, useT } from '@/lib/i18n/client';
import { weekdayName } from '@/lib/calendar';
import { DAYS, LIMITS, nextUid, type DraftErrors, type KnowledgeDraft } from './model';
import { packOf, tx } from '@/lib/verticals';
import type { Vertical } from '@/lib/types';

const timeInput =
  'min-h-11 rounded-xl border border-line-2 bg-sunken px-3 py-2 font-mono text-[15px] text-white sm:text-sm';

/**
 * The editable review of everything she knows: business, services and prices, hours, area, FAQs.
 * Fully controlled: the parent owns the draft, validation errors and saving.
 */
export function KnowledgeForm({
  draft, onChange, errors, showBusiness = true, vertical,
}: {
  draft: KnowledgeDraft;
  onChange: (d: KnowledgeDraft) => void;
  errors: DraftErrors;
  showBusiness?: boolean;
  /** The business's trade: only changes the example in the service-name placeholder. */
  vertical?: Vertical | null;
}) {
  const t = useT();
  const locale = useLocale();
  const servicePlaceholder = tx(packOf(vertical).hints.servicePlaceholder, locale);
  const dayName = (key: string) => weekdayName(({ sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 } as Record<string, number>)[key] ?? 0, locale);
  const set = <K extends keyof KnowledgeDraft>(k: K, v: KnowledgeDraft[K]) => onChange({ ...draft, [k]: v });

  return (
    <div className="flex flex-col gap-4">
      {errors.general ? <p role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">{errors.general}</p> : null}

      {showBusiness ? (
        <Card>
          <CardHead title={t('kb.form.business')} subtitle={t('kb.form.businessSub')} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <TextField label={t('kb.form.name')} value={draft.name} maxLength={LIMITS.name} autoComplete="organization"
              onChange={(e) => set('name', e.target.value)} error={errors.name} />
            <TextField label={t('kb.form.ownerName')} value={draft.ownerName} maxLength={LIMITS.name} autoComplete="name"
              onChange={(e) => set('ownerName', e.target.value)} error={errors.ownerName}
              hint={t('kb.form.ownerHint')} />
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHead
          title={t('kb.form.services')}
          subtitle={t('kb.form.servicesSub')}
          right={<span className="text-xs text-dim">{draft.services.length}/{LIMITS.services}</span>}
        />
        <ul className="divide-y divide-[#171f2a]">
          {draft.services.map((s, i) => {
            const e = errors.services[i] ?? {};
            const update = (patch: Partial<typeof s>) =>
              set('services', draft.services.map((x) => (x.uid === s.uid ? { ...x, ...patch } : x)));
            return (
              <li key={s.uid} className="p-4 sm:p-5">
                <div className="grid gap-3 sm:grid-cols-[1fr_120px_110px]">
                  <TextField label={t('kb.form.serviceName', { n: i + 1 })} srOnlyLabel value={s.name} placeholder={servicePlaceholder}
                    maxLength={LIMITS.serviceName} onChange={(ev) => update({ name: ev.target.value })} error={e.name} />
                  <TextField label={t('kb.form.servicePrice', { n: i + 1 })} srOnlyLabel value={s.price} inputMode="decimal"
                    placeholder={t('kb.form.pricePlaceholder')} onChange={(ev) => update({ price: ev.target.value })} error={e.price} />
                  <TextField label={t('kb.form.serviceDuration', { n: i + 1 })} srOnlyLabel value={s.duration} inputMode="numeric"
                    placeholder={t('kb.form.minutesPlaceholder')} onChange={(ev) => update({ duration: ev.target.value })} error={e.duration} />
                </div>
                <TextField label={t('kb.form.serviceDescription', { n: i + 1 })} srOnlyLabel className="mt-3" value={s.description}
                  placeholder={t('kb.form.descPlaceholder')} maxLength={LIMITS.description + 20}
                  onChange={(ev) => update({ description: ev.target.value })} error={e.description} />
                <Button variant="ghost" className="mt-2 text-xs text-dim"
                  aria-label={s.name ? t('kb.form.removeServiceNamed', { n: i + 1, name: s.name }) : t('kb.form.removeService', { n: i + 1 })}
                  onClick={() => set('services', draft.services.filter((x) => x.uid !== s.uid))}>
                  {t('common.remove')}
                </Button>
              </li>
            );
          })}
          {draft.services.length === 0 ? (
            <li className="px-5 py-6 text-center text-[13px] text-dim">{t('kb.form.noServices')}</li>
          ) : null}
        </ul>
        <div className="border-t border-line p-4">
          <Button variant="outline" disabled={draft.services.length >= LIMITS.services}
            onClick={() => set('services', [...draft.services, { uid: nextUid(), name: '', description: '', price: '', duration: '' }])}>
            {t('kb.form.addService')}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHead title={t('kb.form.hours')} subtitle={t('kb.form.hoursSub')} />
        <fieldset className="divide-y divide-[#171f2a]">
          <legend className="sr-only">{t('kb.form.hoursLegend')}</legend>
          {DAYS.map((day) => {
            const h = draft.hours[day.key];
            const err = errors.hours[day.key];
            const update = (patch: Partial<typeof h>) => set('hours', { ...draft.hours, [day.key]: { ...h, ...patch } });
            return (
              <div key={day.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                <label className="flex min-h-11 w-32 items-center gap-2.5 text-[13px] text-soft">
                  <input type="checkbox" checked={h.open} onChange={(e) => update({ open: e.target.checked })}
                    className="h-5 w-5 accent-brand" />
                  {dayName(day.key)}
                </label>
                {h.open ? (
                  <div className="flex items-center gap-2">
                    <input type="time" aria-label={t('kb.form.opens', { day: dayName(day.key) })} value={h.from} onChange={(e) => update({ from: e.target.value })}
                      aria-invalid={err ? true : undefined} className={timeInput} />
                    <span aria-hidden="true" className="text-dim">{t('kb.form.to')}</span>
                    <input type="time" aria-label={t('kb.form.closes', { day: dayName(day.key) })} value={h.to} onChange={(e) => update({ to: e.target.value })}
                      aria-invalid={err ? true : undefined} className={timeInput} />
                  </div>
                ) : (
                  <span className="text-[13px] text-dim">{t('kb.form.closed')}</span>
                )}
                {err ? <p role="alert" className="w-full text-xs text-danger">{dayName(day.key)}: {err}</p> : null}
              </div>
            );
          })}
        </fieldset>
      </Card>

      <Card>
        <CardHead title={t('kb.form.where')} />
        <div className="p-5">
          <TextAreaField label={t('kb.form.serviceArea')} rows={2} value={draft.serviceArea} onChange={(e) => set('serviceArea', e.target.value)}
            placeholder={t('kb.form.areaPlaceholder')} error={errors.serviceArea}
            hint={t('kb.form.areaHint')} />
        </div>
      </Card>

      <Card>
        <CardHead title={t('kb.form.faqs')} subtitle={t('kb.form.faqsSub')}
          right={<span className="text-xs text-dim">{draft.faqs.length}/{LIMITS.faqs}</span>} />
        <ul className="divide-y divide-[#171f2a]">
          {draft.faqs.map((f, i) => {
            const e = errors.faqs[i] ?? {};
            const update = (patch: Partial<typeof f>) => set('faqs', draft.faqs.map((x) => (x.uid === f.uid ? { ...x, ...patch } : x)));
            return (
              <li key={f.uid} className="p-4 sm:p-5">
                <TextField label={t('kb.form.question', { n: i + 1 })} value={f.question} onChange={(ev) => update({ question: ev.target.value })} error={e.question} />
                <TextAreaField label={t('kb.form.answer', { n: i + 1 })} className="mt-3" rows={2} value={f.answer}
                  onChange={(ev) => update({ answer: ev.target.value })} error={e.answer} />
                <Button variant="ghost" className="mt-2 text-xs text-dim" aria-label={t('kb.form.removeQuestion', { n: i + 1 })}
                  onClick={() => set('faqs', draft.faqs.filter((x) => x.uid !== f.uid))}>
                  {t('common.remove')}
                </Button>
              </li>
            );
          })}
          {draft.faqs.length === 0 ? (
            <li className="px-5 py-6 text-center text-[13px] text-dim">{t('kb.form.noFaqs')}</li>
          ) : null}
        </ul>
        <div className="border-t border-line p-4">
          <Button variant="outline" disabled={draft.faqs.length >= LIMITS.faqs}
            onClick={() => set('faqs', [...draft.faqs, { uid: nextUid(), question: '', answer: '' }])}>
            {t('kb.form.addFaq')}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHead title={t('kb.form.pricing')} subtitle={t('kb.form.pricingSub')} />
        <div className="p-5">
          <TextAreaField label={t('kb.form.pricing')} optional rows={3} value={draft.pricingNotes} maxLength={LIMITS.notes + 50}
            onChange={(e) => set('pricingNotes', e.target.value)} error={errors.pricingNotes}
            hint={t('kb.form.pricingHint')} />
        </div>
      </Card>
    </div>
  );
}
