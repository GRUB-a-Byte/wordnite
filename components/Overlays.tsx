'use client';

import { AnimatePresence, m } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useRoom } from '@/lib/client/store';
import { formatClock, useLatestFx, usePhaseRemaining } from './hooks';

/**
 * FR-5.3 banners — shown in an aria-live region (UI-13). Driven by synchronized engine events, so
 * every screen shows the same banner at the same moment.
 */
export function Banners() {
  const { me, players, overtimeMs } = useRoom(
    useShallow((s) => ({ me: s.me, players: s.game?.players ?? [], overtimeMs: s.game?.settings.overtimeMs ?? 0 })),
  );
  const solved = useLatestFx('SOLVED');
  const overtime = useLatestFx('OVERTIME_START');
  // FR-8.2: "New challenger" when a hill-holder is re-paired (never at the start of a plain 1v1).
  const paired = useLatestFx('PAIRED', (e) => e.playerIds.includes(me) && players.some((p) => (p.streak ?? 0) > 0));
  const name = (id: string) => players.find((p) => p.id === id)?.nickname ?? '?';
  const amPlayer = players.some((p) => p.id === me);

  let banner: { key: string; text: string; tone: string } | null = null;
  const newest = Math.max(overtime?.id ?? 0, solved?.id ?? 0);
  if (paired && paired.id > newest) {
    const opp = paired.event.playerIds.find((id) => id !== me);
    const oppStreak = players.find((p) => p.id === opp)?.streak ?? 0;
    banner = {
      key: `paired-${paired.id}`,
      text: `⚔ New challenger: ${name(opp ?? '')}${oppStreak > 0 ? ` (👑${oppStreak})` : ''}`,
      tone: 'bg-gradient-to-r from-royal to-fuchsia-500 text-white',
    };
  } else if (overtime && (!solved || overtime.id > solved.id)) {
    banner = {
      key: `ot-${overtime.id}`,
      text: `OVERTIME! +${overtime.event.extraRows} rows each — ${formatClock(overtimeMs)} on the clock`,
      tone: 'bg-shield text-black',
    };
  } else if (solved) {
    const n = solved.event.rows;
    const mine = solved.event.playerId === me;
    banner = {
      key: `solved-${solved.id}`,
      text: mine
        ? 'Shielded! Hunt them down.'
        : amPlayer
          ? n > 1
            ? `${name(solved.event.playerId)} solved in ${n} rows — beat ${n - 1} or fewer to win!`
            : `${name(solved.event.playerId)} solved in 1 row!`
          : `${name(solved.event.playerId)} solved in ${n} rows and is shielded!`,
      tone: mine ? 'bg-shield text-black' : 'bg-royal text-white',
    };
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-40 flex justify-center px-3" aria-live="polite" role="status">
      <AnimatePresence>
        {banner && (
          <m.div
            key={banner.key}
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: [0, 1, 1, 0] }}
            transition={{ duration: 3.6, times: [0, 0.08, 0.85, 1] }}
            className={`max-w-xl rounded-2xl px-4 py-2.5 text-center text-sm font-black shadow-2xl sm:text-lg ${banner.tone}`}
            data-testid="banner"
          >
            {banner.text}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** GR-4: 3-2-1 countdown, then "GO!". */
export function CountdownOverlay() {
  const phase = useRoom((s) => s.game?.phase);
  const remaining = usePhaseRemaining(100);
  const go = useLatestFx('PLAY_STARTED');
  const n = phase === 'COUNTDOWN' && remaining !== null ? Math.max(1, Math.ceil(remaining / 1000)) : null;
  return (
    <AnimatePresence>
      {n !== null && (
        <m.div
          key="countdown"
          className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-night/60 backdrop-blur-sm"
          exit={{ opacity: 0 }}
          data-testid="countdown"
        >
          <m.span
            key={n}
            initial={{ scale: 2.2, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-[28vmin] font-black text-ink drop-shadow-[0_0_40px_rgb(139_92_246/0.8)]"
          >
            {n}
          </m.span>
        </m.div>
      )}
      {n === null && go && phase === 'PLAYING' && (
        <m.div
          key={`go-${go.id}`}
          className="pointer-events-none fixed inset-0 z-40 grid place-items-center"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ delay: 0.5, duration: 0.4 }}
        >
          <m.span
            initial={{ scale: 0.6 }}
            animate={{ scale: 1.2 }}
            className="text-[22vmin] font-black text-correct drop-shadow-[0_0_40px_rgb(20_184_166/0.8)]"
          >
            GO!
          </m.span>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/** Original winged figure (UI-12) — simple geometric SVG, no third-party art. */
function WingedFigure() {
  const feathers = (side: 1 | -1) =>
    Array.from({ length: 5 }, (_, i) => (
      <path
        key={i}
        d={`M0 0 Q ${side * (40 + i * 14)} ${-30 + i * 10} ${side * (70 + i * 16)} ${-4 + i * 14} Q ${side * (40 + i * 10)} ${6 + i * 6} 0 ${8 + i * 2}`}
        fill={i % 2 ? '#fde68a' : '#fbbf24'}
        opacity={0.95 - i * 0.08}
      />
    ));
  return (
    <svg viewBox="-160 -110 320 220" className="h-full w-full drop-shadow-[0_0_30px_rgb(251_191_36/0.7)]" aria-hidden>
      <g transform="translate(0 -6)">
        <g className="origin-center">{feathers(-1)}</g>
        <g>{feathers(1)}</g>
      </g>
      <ellipse cx="0" cy="-58" rx="22" ry="6" fill="none" stroke="#fde68a" strokeWidth="4" />
      <circle cx="0" cy="-34" r="16" fill="#f8fafc" />
      <path d="M-20 -14 L20 -14 L30 60 L-30 60 Z" fill="#e2e8f0" />
      <path d="M-30 60 L30 60 L22 72 L-22 72 Z" fill="#fbbf24" />
      <circle cx="-5" cy="-36" r="2" fill="#0f172a" />
      <circle cx="5" cy="-36" r="2" fill="#0f172a" />
    </svg>
  );
}

/**
 * UI-12 overtime "winged god": a 2-second, non-blocking (pointer-events: none) overlay. Flies in
 * from the top, drops "+3" onto each side, and flies off. Overtime LOGIC lives in the engine.
 */
export function OvertimeGod() {
  const ot = useLatestFx('OVERTIME_START');
  return (
    <AnimatePresence>
      {ot && (
        <m.div
          key={ot.id}
          className="pointer-events-none fixed inset-0 z-40 overflow-hidden"
          initial={{ opacity: 1 }}
          animate={{ opacity: [1, 1, 0] }}
          transition={{ duration: 2.2, times: [0, 0.85, 1] }}
          data-testid="overtime-god"
        >
          <m.div
            className="absolute left-1/2 h-48 w-72 -translate-x-1/2 sm:h-64 sm:w-96"
            initial={{ y: '-60vh', rotate: -6 }}
            animate={{ y: ['-60vh', '12vh', '12vh', '-70vh'], rotate: [-6, 3, -3, 8] }}
            transition={{ duration: 2, times: [0, 0.3, 0.7, 1], ease: 'easeInOut' }}
          >
            <WingedFigure />
          </m.div>
          {[25, 75].map((left) => (
            <m.span
              key={left}
              className="absolute text-5xl font-black text-shield drop-shadow-[0_0_18px_rgb(251_191_36/0.9)] sm:text-7xl"
              style={{ left: `${left}%` }}
              initial={{ top: '22%', opacity: 0, x: '-50%' }}
              animate={{ top: ['22%', '22%', '55%'], opacity: [0, 1, 0] }}
              transition={{ duration: 1.6, delay: 0.5, times: [0, 0.2, 1] }}
            >
              +{ot.event.extraRows}
            </m.span>
          ))}
        </m.div>
      )}
    </AnimatePresence>
  );
}
