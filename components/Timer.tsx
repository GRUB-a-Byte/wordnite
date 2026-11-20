'use client';

import { useRoom } from '@/lib/client/store';
import { formatClock, usePhaseRemaining } from './hooks';

/** FR-5.1: m:ss, red under 0:20, pulsing under 0:10, "OVERTIME" label during overtime. */
export function Timer({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const phase = useRoom((s) => s.game?.phase);
  const remaining = usePhaseRemaining();
  if (!phase || remaining === null || (phase !== 'PLAYING' && phase !== 'OVERTIME')) {
    return <div className={size === 'sm' ? 'h-8' : 'h-14'} />;
  }
  const overtime = phase === 'OVERTIME';
  const danger = remaining <= 20_000;
  const pulse = remaining <= 10_000;
  const text = size === 'lg' ? 'text-6xl sm:text-8xl' : size === 'md' ? 'text-4xl sm:text-5xl' : 'text-2xl';
  return (
    <div className="flex flex-col items-center leading-none" role="timer" aria-live="off" data-testid="timer">
      {overtime && (
        <span className="mb-1 rounded-full bg-shield px-2 py-0.5 text-[10px] font-black tracking-widest text-black uppercase sm:text-xs">
          Overtime
        </span>
      )}
      <span
        className={`font-black tabular-nums ${text} ${danger ? 'text-steal' : 'text-ink'} ${pulse ? 'timer-pulse' : ''}`}
      >
        {formatClock(remaining)}
      </span>
    </div>
  );
}
