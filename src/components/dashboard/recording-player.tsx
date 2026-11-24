'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n/client';

/**
 * Plays a call recording through the authenticated proxy (/api/calls/:id/audio): the browser's own audio controls (keyboard and screen
 * reader accessible, seeking uses Range). Nothing loads until the person asks (preload none). Only mounted for calls that may be played.
 */
export function RecordingPlayer({ callId, label }: { callId: string; label: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  return (
    <div className="mt-3">
      <p id={`rec-${callId}`} className="text-xs text-dim">{t('recording.title')}</p>
      {failed ? (
        <p role="status" className="mt-1 text-xs text-warn">{t('recording.unavailable')}</p>
      ) : (
        <audio controls preload="none" aria-label={t('recording.label', { who: label })} src={`/api/calls/${encodeURIComponent(callId)}/audio`} onError={() => setFailed(true)} className="mt-1 h-11 w-full max-w-md" />
      )}
    </div>
  );
}
