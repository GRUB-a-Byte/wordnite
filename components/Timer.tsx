'use client';

import { formatClock, useClock } from './hooks';

const SIZE = {
  // sm sits inside the phone header: one line, OVERTIME label inline so the header never grows.
  sm: { box: 'h-7 flex-row gap-1.5', text: 'text-2xl', pill: 'text-[9px] px-1.5' },
  md: { box: 'min-h-[3.2rem] flex-col', text: 'text-[clamp(32px,5vmin,52px)]', pill: 'mb-1 text-[10px] px-2' },
  lg: { box: 'min-h-[clamp(34px,7.5vmin,112px)] flex-col', text: 'text-[clamp(30px,7vmin,104px)]', pill: 'mb-1 text-[clamp(10px,1.6vmin,16px)] px-2' },
} as const;

/**
 * FR-5.1: m:ss, red under 0:20, pulsing under 0:10, "OVERTIME" label during overtime.
 * v1.1 FD-7: in a battle royale it shows `playerId`'s own duel clock (nothing while waiting).
 */
export function Timer({ size = 'md', playerId }: { size?: 'sm' | 'md' | 'lg'; playerId?: string }) {
  const { phase, remaining } = useClock(200, playerId);
  const s = SIZE[size];
  if (!phase || remaining === null || (phase !== 'PLAYING' && phase !== 'OVERTIME')) {
    return <div className={`flex ${s.box}`} />;
  }
  const overtime = phase === 'OVERTIME';
  const danger = remaining <= 20_000;
  const pulse = remaining <= 10_000;
  return (
    <div className={`flex items-center justify-center leading-none ${s.box}`} role="timer" aria-live="off" data-testid="timer">
      {overtime && (
        <span className={`rounded-full bg-shield py-0.5 font-black tracking-widest text-on-accent uppercase ${s.pill}`}>
          {size === 'sm' ? 'OT' : 'Overtime'}
        </span>
      )}
      <span className={`font-black tabular-nums ${s.text} ${danger ? 'text-steal-ink' : 'text-ink'} ${pulse ? 'timer-pulse' : ''}`}>
        {formatClock(remaining)}
      </span>
    </div>
  );
}
