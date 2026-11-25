'use client';
import { useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { cn } from './cn';

export function VoicePlayer({
  src, label, className, bars = 42, preload, idleLabel,
}: { src?: string | null; label: string; className?: string; bars?: number; preload?: 'none' | 'metadata' | 'auto'; idleLabel?: string }) {
  const t = useT();
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  // Derived, not synced: a new `src` clears a previous failure on its own, which an
  // effect-based reset did not do.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const missing = !src || failedSrc === src;

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (playing) el.pause();
    else el.play().catch(() => setFailedSrc(src ?? null)); // autoplay policy / decode error: show "audio unavailable"
  };

  return (
    <div className={cn('rounded-2xl border border-line bg-[#101720] p-4', className)}>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={toggle}
          disabled={missing}
          aria-label={`${playing ? t('audio.pause') : t('audio.play')}: ${label}`}
          aria-pressed={playing}
          className={cn(
            'grid h-11 w-11 shrink-0 place-items-center rounded-full transition',
            missing
              ? 'bg-[#1b232e] text-dim'
              : 'bg-brand text-on-brand hover:bg-brand-hover',
          )}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="2" y="1" width="3.5" height="12" rx="1" />
              <rect x="8.5" y="1" width="3.5" height="12" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M3 1.5v11a1 1 0 0 0 1.5.87l8-5.5a1 1 0 0 0 0-1.74l-8-5.5A1 1 0 0 0 3 1.5Z" />
            </svg>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-xs font-medium text-soft">{label}</p>
            <span className="shrink-0 text-xs tabular-nums text-dim">
              {!src ? t('audio.pending') : missing ? t('audio.unavailable') : playing ? t('audio.playing') : (idleLabel ?? t('audio.voiceNote'))}
            </span>
          </div>
          {/* DECORATION, not the audio's waveform: the bar heights are a fixed pseudo-random pattern (no audio analysis). The only real
              information is the filled portion, which is the playback progress (role=progressbar). */}
          <div
            role="progressbar"
            aria-label={`${t('audio.progress')}, ${label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="mt-2 flex h-8 items-center gap-[3px]"
          >
            {Array.from({ length: bars }).map((_, i) => {
              const seed = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
              const h = Math.round(20 + seed * 80);
              const active = progress * bars > i;
              return (
                <span
                  key={i}
                  aria-hidden="true"
                  className={cn(
                    'w-full rounded-full transition-colors',
                    playing && active ? 'bar' : '',
                    active ? 'bg-brand' : 'bg-[#24303f]',
                  )}
                  style={{
                    height: `${h}%`,
                    animationDelay: `${(i % 7) * 90}ms`,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {src ? (
        <audio
          ref={ref}
          src={src}
          preload={preload}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (el.duration) setProgress(el.currentTime / el.duration);
          }}
          onError={() => setFailedSrc(src ?? null)}
          className="hidden"
        />
      ) : null}
    </div>
  );
}
