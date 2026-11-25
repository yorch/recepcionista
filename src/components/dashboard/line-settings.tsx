'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { useReauth } from '@/components/dashboard/reauth';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import type { LineSettings } from '@/app/api/businesses/[id]/line/route';

type Saved = LineSettings & { agent_sync?: { agent: 'synced' | 'skipped' | 'failed' } };

/**
 * Settings > Receptionist and phone line: the receptionist's name (assistant_name), the live-transfer opt-in (native_transfer_enabled) and the status of the
 * business's own phone line. Owner-only page. Turning transfer ON asks for a recent proof of identity (step-up panel) and is disabled while the platform
 * capability is off. Plain labels, keyboard operable, 44px targets, and it wraps at phone width.
 */
export function LineSettingsCard({ businessId, initial }: { businessId: string; initial: LineSettings }) {
  const t = useT();
  const router = useRouter();
  const [view, setView] = useState<LineSettings>(initial);
  const [name, setName] = useState(initial.assistant_name ?? '');
  const [busy, setBusy] = useState<'name' | 'transfer' | null>(null);
  const { guard, panel } = useReauth((err) => toast.error(errorText(t, err)));

  async function patch(body: Record<string, unknown>, kind: 'name' | 'transfer') {
    setBusy(kind);
    try {
      const next = await apiRequest<Saved>(`/api/businesses/${businessId}/line`, { method: 'PATCH', body });
      setView(next);
      setName(next.assistant_name ?? '');
      const failed = next.agent_sync?.agent === 'failed';
      toast[failed ? 'warning' : 'success'](failed ? t(kind === 'name' ? 'line.name.savedPending' : 'line.transfer.savedPending')
        : kind === 'name' ? t(next.agent_sync?.agent === 'synced' ? 'line.name.savedSynced' : 'line.name.saved') : t('line.transfer.saved'));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function saveName() {
    try { await patch({ assistant_name: name.trim() === '' ? null : name }, 'name'); } catch (err) { toast.error(errorText(t, err)); }
  }
  async function toggleTransfer() {
    const next = !view.native_transfer_enabled;
    try { await guard(() => patch({ native_transfer_enabled: next }, 'transfer')); } catch (err) { toast.error(errorText(t, err)); }
  }

  const dirty = name.trim() !== (view.assistant_name ?? '');
  const canToggle = view.transfer_capability || view.native_transfer_enabled;
  const statusKey = view.own_line ? 'line.status.own' : !view.has_number ? 'line.status.none' : view.line_kind === 'webhook' ? 'line.status.webhook' : 'line.status.shared';

  return (
    <div className="flex flex-col gap-6">
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (dirty && busy === null) void saveName(); }}>
        <TextField
          label={t('line.name.label')} value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)}
          placeholder={t('line.name.placeholder', { default: view.default_assistant_name })}
          hint={t('line.name.hint', { default: view.default_assistant_name })}
        />
        <p className="text-xs text-dim" aria-live="polite">{t('line.name.current', { name: view.assistant_name_effective })}</p>
        <div className="flex"><Button type="submit" disabled={busy !== null || !dirty}>{busy === 'name' ? t('common.saving') : t('line.name.save')}</Button></div>
      </form>

      <div className="border-t border-line-2 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p id="line-transfer-label" className="text-[13px] font-medium text-white">{t('line.transfer.label')}</p>
            <p id="line-transfer-desc" className="mt-1 text-xs leading-relaxed text-dim">{t('line.transfer.desc')}</p>
          </div>
          <button
            type="button" role="switch" aria-checked={view.native_transfer_enabled} aria-labelledby="line-transfer-label" aria-describedby="line-transfer-desc"
            aria-disabled={busy !== null || !canToggle} disabled={!canToggle}
            onClick={() => { if (busy === null) void toggleTransfer(); }}
            className={`relative inline-flex h-11 w-[72px] shrink-0 items-center rounded-full border px-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${view.native_transfer_enabled ? 'border-mint-line bg-mint-bg' : 'border-line-3 bg-sunken'} ${!canToggle ? 'opacity-50' : ''}`}
          >
            <span aria-hidden="true" className={`h-8 w-8 rounded-full bg-white transition-transform ${view.native_transfer_enabled ? 'translate-x-[28px]' : 'translate-x-0'}`} />
          </button>
        </div>
        <p role="status" aria-live="polite" className="mt-2 text-xs text-dim">{view.native_transfer_enabled ? t('line.transfer.on') : t('line.transfer.off')}</p>
        {!view.transfer_capability ? <p className="mt-2 text-xs text-warn">{t('line.transfer.unavailable')}</p> : null}
        {view.transfer_capability && !view.forward_number_verified ? <p className="mt-2 text-xs text-warn">{t('line.transfer.needsNumber')}</p> : null}
      </div>

      <div className="border-t border-line-2 pt-5">
        <p className="text-[12px] font-medium text-white">{t('line.status.title')}</p>
        <p className="mt-1 text-xs text-dim">{t(statusKey)}</p>
      </div>
      {panel}
    </div>
  );
}
