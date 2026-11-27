'use client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { ImpactView } from '@/lib/admin/ops-model';

/**
 * The impact preview of a staged change (counts of real tenants / phones / rows it would touch), rendered inside the review step of every console write. Each impact is one
 * sentence with the headline number, optionally followed by the heaviest tenants. Nothing is shown when the server has no preview for the staged keys.
 */
export function ImpactPanel({ impacts }: { impacts: ImpactView[] | undefined }) {
  const t = useT();
  if (!impacts || impacts.length === 0) return null;
  return (
    <section aria-label={t('ao.impact.title')} className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-bg/30 p-3">
      <p className="text-[13px] font-semibold text-warn">{t('ao.impact.title')}</p>
      <ul className="flex flex-col gap-2">
        {impacts.map((i) => (
          <li key={`${i.id}-${i.key}`} className="text-[13px] text-soft">
            <p>{t(`ao.impact.${i.id}` as MessageKey, { count: i.count, total: i.total ?? 0, key: i.key, ...Object.fromEntries(Object.entries(i.facts).map(([k, v]) => [k, String(v)])) })}</p>
            {i.rows.length ? (
              <ul className="mt-1 list-disc pl-5 text-xs text-mute">
                {i.rows.slice(0, 5).map((r) => <li key={r.label}>{r.label}: {r.value}</li>)}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

