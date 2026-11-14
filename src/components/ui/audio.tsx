'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from './cn';

export function VoicePlayer({
  src, label, className, bars = 42,
}: { src?: string | null; label: string; className?: string; bars?: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [missing, setMissing] = useState(!src);

  useEffect(() => setMissing(!src), [src]);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play();
  };

  return (
    <div className={cn('rounded-2xl border border-[#1f2937] bg-[#101720] p-4', className)}>
      <div className="flex items-center gap-4">
        <button
          onClick={toggle}
          disabled={missing}
          aria-label={playing ? 'Pause' : 'Play'}
          className={cn(
            'grid h-11 w-11 shrink-0 place-items-center rounded-full transition',
            missing
              ? 'bg-[#1b232e] text-[#5a6b80]'
              : 'bg-[#ff6b35] text-[#150800] hover:bg-[#ff8558]',
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
            <p className="truncate text-xs font-medium text-[#cbd7e6]">{label}</p>
            <span className="shrink-0 text-[11px] tabular-nums text-[#6b7b91]">
              {missing ? 'audio pending' : playing ? 'playing' : 'voice note'}
            </span>
          </div>
          <div className="mt-2 flex h-8 items-center gap-[3px]">
            {Array.from({ length: bars }).map((_, i) => {
              const seed = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
              const h = 20 + seed * 80;
              const active = progress * bars > i;
              return (
                <span
                  key={i}
                  className={cn(
                    'w-full rounded-full transition-colors',
                    playing && active ? 'bar' : '',
                    active ? 'bg-[#ff6b35]' : 'bg-[#24303f]',
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
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (el.duration) setProgress(el.currentTime / el.duration);
          }}
          onError={() => setMissing(true)}
          className="hidden"
        />
      ) : null}
    </div>
  );
}
