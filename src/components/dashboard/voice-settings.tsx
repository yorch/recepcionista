'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import type { VoiceSettings } from '@/app/api/businesses/[id]/voice/route';

/** Choose the receptionist's voice from the allowlist; listen to a sample first. Disabled (with the reason) without an ElevenLabs connection. */
export function VoiceSettingsCard({ businessId }: { businessId: string }) {
  const t = useT();
  const legend = useId();
  const [state, setState] = useState<VoiceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<VoiceSettings>(`/api/businesses/${businessId}/voice`, { signal: ctrl.signal })
      .then((s) => { setState(s); setSelected(s.voice_id ?? ''); })
      .catch((e) => { if (!ctrl.signal.aborted) setError(errorText(t, e, 'voice.loadFailed')); });
    return () => ctrl.abort();
  }, [businessId, t]);

  function play(id: string) {
    setPreview(id);
    const el = audio.current;
    if (!el) return;
    el.src = `/api/businesses/${businessId}/voice/preview?voice_id=${encodeURIComponent(id)}`;
    el.play().catch(() => toast.error(t('voice.sampleFailed')));
  }

  async function save() {
    setBusy(true);
    try {
      const r = await apiRequest<{ voice_id: string | null; voice_name: string | null; synced: boolean }>(`/api/businesses/${businessId}/voice`, { method: 'PUT', body: { voice_id: selected || null } });
      setState((s) => (s ? { ...s, voice_id: r.voice_id, voice_name: r.voice_name } : s));
      toast.success(r.synced ? t('voice.saved') : t('voice.savedLater'));
    } catch (e) {
      toast.error(errorText(t, e, 'voice.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p role="alert" className="text-[13px] text-danger">{error}</p>;
  if (!state) return <p className="text-[13px] text-dim">{t('voice.loading')}</p>;
  if (!state.available) return <p className="text-[13px] text-dim">{t('voice.unavailable')}</p>;
  if (state.voices.length === 0) return <p className="text-[13px] text-dim">{t('voice.none')}</p>;

  const dirty = (state.voice_id ?? '') !== selected;
  return (
    <div>
      <fieldset>
        <legend id={legend} className="text-[13px] text-soft">{t('voice.current')} <strong className="text-white">{state.voice_name ?? t('voice.default')}</strong></legend>
        <div role="radiogroup" aria-labelledby={legend} className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line-3 px-3 py-2 has-[:checked]:border-brand has-[:checked]:bg-brand-bg">
            <input type="radio" name="voice" value="" checked={selected === ''} onChange={() => setSelected('')} className="h-4 w-4 accent-[#ff6b35]" />
            <span className="text-[13px] text-soft">{t('voice.defaultVoice')}</span>
          </label>
          {state.voices.map((v) => (
            <div key={v.voice_id} className="flex items-center gap-2 rounded-xl border border-line-3 px-3 py-1 has-[:checked]:border-brand has-[:checked]:bg-brand-bg">
              <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3">
                <input type="radio" name="voice" value={v.voice_id} checked={selected === v.voice_id} onChange={() => setSelected(v.voice_id)} className="h-4 w-4 accent-[#ff6b35]" />
                <span className="min-w-0 text-[13px] text-soft">{v.name}{v.description ? <span className="block truncate text-xs text-dim">{v.description}</span> : null}</span>
              </label>
              {v.has_preview ? (
                <button type="button" onClick={() => play(v.voice_id)} aria-label={t('voice.playLabel', { name: v.name })} className="min-h-11 rounded-lg px-2 text-xs text-brand-soft hover:underline" aria-pressed={preview === v.voice_id}>{t('voice.sample')}</button>
              ) : null}
            </div>
          ))}
        </div>
      </fieldset>
      <audio ref={audio} className="sr-only" aria-hidden="true" />
      <div className="mt-4"><Button onClick={save} disabled={busy || !dirty}>{busy ? t('common.saving') : t('voice.save')}</Button></div>
    </div>
  );
}
