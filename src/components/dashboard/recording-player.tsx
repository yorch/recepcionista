'use client';
import { useState } from 'react';

/**
 * Plays a call recording through the authenticated proxy (/api/calls/:id/audio): the browser's own audio controls (keyboard and screen
 * reader accessible, seeking uses Range). Nothing loads until the person asks (preload none). Only mounted for calls that may be played.
 */
export function RecordingPlayer({ callId, label }: { callId: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="mt-3">
      <p id={`rec-${callId}`} className="text-xs text-dim">Call recording</p>
      {failed ? (
        <p role="status" className="mt-1 text-xs text-warn">The recording is not available (it may have expired or been deleted).</p>
      ) : (
        <audio controls preload="none" aria-label={`Recording of ${label}`} src={`/api/calls/${encodeURIComponent(callId)}/audio`} onError={() => setFailed(true)} className="mt-1 h-11 w-full max-w-md" />
      )}
    </div>
  );
}
