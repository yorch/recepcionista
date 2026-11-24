'use client';
import { useId } from 'react';
import { VERTICALS, type Vertical } from '@/lib/types';
import { packOf, tx } from '@/lib/verticals';

/** The trade choice (onboarding and settings). A native select: keyboard and screen-reader friendly, the blurb is tied to it with aria-describedby. */
export function VerticalPicker({
  value, onChange, disabled, lang = 'en', label = 'What kind of business is it?',
}: {
  value: Vertical;
  onChange: (v: Vertical) => void;
  disabled?: boolean;
  lang?: 'en' | 'es';
  label?: string;
}) {
  const id = useId();
  const pack = packOf(value);
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium uppercase tracking-wider text-dim">{label}</label>
      <select
        id={id} value={value} disabled={disabled} aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value as Vertical)}
        className="mt-1.5 min-h-11 w-full max-w-md rounded-xl border border-line-3 bg-sunken px-3 text-[15px] text-white sm:text-sm"
      >
        {VERTICALS.map((v) => <option key={v} value={v}>{tx(packOf(v).label, lang)}</option>)}
      </select>
      <p id={`${id}-hint`} className="mt-1.5 text-xs text-dim">{tx(pack.blurb, lang)}</p>
    </div>
  );
}
