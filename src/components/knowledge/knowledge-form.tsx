'use client';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { DAYS, LIMITS, nextUid, type DraftErrors, type KnowledgeDraft } from './model';

const timeInput =
  'min-h-11 rounded-xl border border-line-2 bg-sunken px-3 py-2 font-mono text-[15px] text-white sm:text-sm';

/**
 * The editable review of everything she knows: business, services and prices, hours, area, FAQs.
 * Fully controlled: the parent owns the draft, validation errors and saving.
 */
export function KnowledgeForm({
  draft, onChange, errors, showBusiness = true,
}: {
  draft: KnowledgeDraft;
  onChange: (d: KnowledgeDraft) => void;
  errors: DraftErrors;
  showBusiness?: boolean;
}) {
  const set = <K extends keyof KnowledgeDraft>(k: K, v: KnowledgeDraft[K]) => onChange({ ...draft, [k]: v });

  return (
    <div className="flex flex-col gap-4">
      {errors.general ? <p role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">{errors.general}</p> : null}

      {showBusiness ? (
        <Card>
          <CardHead title="Your business" subtitle="How she introduces you" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <TextField label="Business name" value={draft.name} maxLength={LIMITS.name} autoComplete="organization"
              onChange={(e) => set('name', e.target.value)} error={errors.name} />
            <TextField label="Owner name" value={draft.ownerName} maxLength={LIMITS.name} autoComplete="name"
              onChange={(e) => set('ownerName', e.target.value)} error={errors.ownerName}
              hint="She says this when she hands a call to you." />
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHead
          title="Services and prices"
          subtitle="She quotes these as starting prices, never more"
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
                  <TextField label={`Service ${i + 1} name`} srOnlyLabel value={s.name} placeholder="Service name, e.g. AC repair"
                    maxLength={LIMITS.serviceName} onChange={(ev) => update({ name: ev.target.value })} error={e.name} />
                  <TextField label={`Service ${i + 1} starting price in dollars`} srOnlyLabel value={s.price} inputMode="decimal"
                    placeholder="Price $ (blank = quote)" onChange={(ev) => update({ price: ev.target.value })} error={e.price} />
                  <TextField label={`Service ${i + 1} duration in minutes`} srOnlyLabel value={s.duration} inputMode="numeric"
                    placeholder="Minutes" onChange={(ev) => update({ duration: ev.target.value })} error={e.duration} />
                </div>
                <TextField label={`Service ${i + 1} description`} srOnlyLabel className="mt-3" value={s.description}
                  placeholder="Short description (optional)" maxLength={LIMITS.description + 20}
                  onChange={(ev) => update({ description: ev.target.value })} error={e.description} />
                <Button variant="ghost" className="mt-2 text-xs text-dim"
                  aria-label={`Remove service ${i + 1}${s.name ? `: ${s.name}` : ''}`}
                  onClick={() => set('services', draft.services.filter((x) => x.uid !== s.uid))}>
                  Remove
                </Button>
              </li>
            );
          })}
          {draft.services.length === 0 ? (
            <li className="px-5 py-6 text-center text-[13px] text-dim">No services yet. Add the jobs customers call about.</li>
          ) : null}
        </ul>
        <div className="border-t border-line p-4">
          <Button variant="outline" disabled={draft.services.length >= LIMITS.services}
            onClick={() => set('services', [...draft.services, { uid: nextUid(), name: '', description: '', price: '', duration: '' }])}>
            Add a service
          </Button>
        </div>
      </Card>

      <Card>
        <CardHead title="Hours" subtitle="When she can book jobs. Outside these hours she takes a message." />
        <fieldset className="divide-y divide-[#171f2a]">
          <legend className="sr-only">Opening hours by day</legend>
          {DAYS.map((day) => {
            const h = draft.hours[day.key];
            const err = errors.hours[day.key];
            const update = (patch: Partial<typeof h>) => set('hours', { ...draft.hours, [day.key]: { ...h, ...patch } });
            return (
              <div key={day.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                <label className="flex min-h-11 w-32 items-center gap-2.5 text-[13px] text-soft">
                  <input type="checkbox" checked={h.open} onChange={(e) => update({ open: e.target.checked })}
                    className="h-5 w-5 accent-brand" />
                  {day.label}
                </label>
                {h.open ? (
                  <div className="flex items-center gap-2">
                    <input type="time" aria-label={`${day.label} opens`} value={h.from} onChange={(e) => update({ from: e.target.value })}
                      aria-invalid={err ? true : undefined} className={timeInput} />
                    <span aria-hidden="true" className="text-dim">to</span>
                    <input type="time" aria-label={`${day.label} closes`} value={h.to} onChange={(e) => update({ to: e.target.value })}
                      aria-invalid={err ? true : undefined} className={timeInput} />
                  </div>
                ) : (
                  <span className="text-[13px] text-dim">Closed</span>
                )}
                {err ? <p role="alert" className="w-full text-xs text-danger">{day.label}: {err}</p> : null}
              </div>
            );
          })}
        </fieldset>
      </Card>

      <Card>
        <CardHead title="Where you work" />
        <div className="p-5">
          <TextAreaField label="Service area" rows={2} value={draft.serviceArea} onChange={(e) => set('serviceArea', e.target.value)}
            placeholder="Miami-Dade County, Broward County" error={errors.serviceArea}
            hint="Cities, counties or ZIP codes, separated by commas. She tells callers outside this area you will check." />
        </div>
      </Card>

      <Card>
        <CardHead title="Answers she has memorized" subtitle="Common questions callers ask"
          right={<span className="text-xs text-dim">{draft.faqs.length}/{LIMITS.faqs}</span>} />
        <ul className="divide-y divide-[#171f2a]">
          {draft.faqs.map((f, i) => {
            const e = errors.faqs[i] ?? {};
            const update = (patch: Partial<typeof f>) => set('faqs', draft.faqs.map((x) => (x.uid === f.uid ? { ...x, ...patch } : x)));
            return (
              <li key={f.uid} className="p-4 sm:p-5">
                <TextField label={`Question ${i + 1}`} value={f.question} onChange={(ev) => update({ question: ev.target.value })} error={e.question} />
                <TextAreaField label={`Answer ${i + 1}`} className="mt-3" rows={2} value={f.answer}
                  onChange={(ev) => update({ answer: ev.target.value })} error={e.answer} />
                <Button variant="ghost" className="mt-2 text-xs text-dim" aria-label={`Remove question ${i + 1}`}
                  onClick={() => set('faqs', draft.faqs.filter((x) => x.uid !== f.uid))}>
                  Remove
                </Button>
              </li>
            );
          })}
          {draft.faqs.length === 0 ? (
            <li className="px-5 py-6 text-center text-[13px] text-dim">No questions yet. Add things like warranty, payment methods or service call fees.</li>
          ) : null}
        </ul>
        <div className="border-t border-line p-4">
          <Button variant="outline" disabled={draft.faqs.length >= LIMITS.faqs}
            onClick={() => set('faqs', [...draft.faqs, { uid: nextUid(), question: '', answer: '' }])}>
            Add a question
          </Button>
        </div>
      </Card>

      <Card>
        <CardHead title="Pricing notes" subtitle="Extra rules she follows when talking about price" />
        <div className="p-5">
          <TextAreaField label="Pricing notes" optional rows={3} value={draft.pricingNotes} maxLength={LIMITS.notes + 50}
            onChange={(e) => set('pricingNotes', e.target.value)} error={errors.pricingNotes}
            hint="For example: service call fee is waived if you book the repair." />
        </div>
      </Card>
    </div>
  );
}
