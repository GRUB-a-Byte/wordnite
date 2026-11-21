'use client';

import { AnimatePresence, m } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { isBattleRoyale } from '@/lib/engine/state';
import { nicknameOf } from '@/lib/client/players';
import { useRoom } from '@/lib/client/store';
import { formatClock, useLatestFx, usePhaseRemaining } from './hooks';

interface Banner {
  key: string;
  text: string;
  tone: string;
}

/** FR-5.3: the banner for the most recent synchronized SOLVED / OVERTIME event (same on every screen). */
function useBanner(): Banner | null {
  const { me, players, overtimeMs } = useRoom(
    useShallow((s) => ({ me: s.me, players: s.game?.players ?? [], overtimeMs: s.game?.settings.overtimeMs ?? 0 })),
  );
  const royale = isBattleRoyale(players.length);
  // Battle royale: only solves that set the score to beat (or your own) get a banner — with 100
  // players, announcing every solve would drown the screen.
  const solved = useLatestFx('SOLVED', (e) => {
    if (!royale || e.playerId === me) return true;
    const best = Math.min(...players.filter((p) => p.solvedInRows !== undefined).map((p) => p.solvedInRows as number));
    return e.rows <= best;
  });
  const overtime = useLatestFx('OVERTIME_START');
  // Battle royale steals that involve you (in a duel a steal ends the match — the end screen says it).
  const hit = useLatestFx('STEAL_HIT', (e) => royale && (e.stealerId === me || e.targetId === me));
  const name = (id: string) => nicknameOf(players, id);
  const amPlayer = players.some((p) => p.id === me);

  if (hit && (!overtime || hit.id > overtime.id) && (!solved || hit.id > solved.id)) {
    const mine = hit.event.stealerId === me;
    return {
      key: `hit-${hit.id}`,
      text: mine ? `💥 You stole ${name(hit.event.targetId)}’s word!` : `💥 ${name(hit.event.stealerId)} stole your word — you’re out`,
      tone: mine ? 'bg-correct text-on-accent' : 'bg-steal text-on-accent',
    };
  }
  if (overtime && (!solved || overtime.id > solved.id)) {
    return {
      key: `ot-${overtime.id}`,
      text: `OVERTIME! +${overtime.event.extraRows} rows each · ${formatClock(overtimeMs)}`,
      tone: 'bg-shield text-on-accent',
    };
  }
  if (solved) {
    const n = solved.event.rows;
    const mine = solved.event.playerId === me;
    const who = name(solved.event.playerId);
    return {
      key: `solved-${solved.id}`,
      text: mine
        ? royale
          ? 'Shielded! Use your steal shots on your target.'
          : 'Shielded! Hunt them down.'
        : royale
          ? `${who} leads — solved in ${n}. That’s the score to beat!`
          : amPlayer
            ? n > 1
              ? `${who} solved in ${n} — solve in ${n - 1} or fewer to win!`
              : `${who} solved in 1 row!`
            : `${who} solved in ${n} rows — shielded!`,
      tone: mine ? 'bg-shield text-on-accent' : 'bg-royal text-on-accent',
    };
  }
  return null;
}

/**
 * One fixed-height line in the page flow (never over the boards): shows the current banner while
 * it is live, otherwise the contextual hint. aria-live so screen readers hear banners (UI-13).
 */
export function StatusLine({ hint }: { hint?: React.ReactNode }) {
  const banner = useBanner();
  return (
    <div
      className="flex h-[clamp(24px,3.6vmin,36px)] w-full min-w-0 items-center justify-center px-1"
      aria-live="polite"
      role="status"
    >
      <AnimatePresence mode="wait" initial={false}>
        {banner ? (
          <m.div
            key={banner.key}
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            title={banner.text}
            className={`max-w-full truncate rounded-full px-3 py-[0.2em] text-[clamp(11px,1.9vmin,18px)] font-black shadow-md ${banner.tone}`}
            data-testid="banner"
          >
            {banner.text}
          </m.div>
        ) : hint ? (
          <m.div
            key="hint"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="max-w-full truncate text-[clamp(11px,1.6vmin,15px)] text-muted"
          >
            {hint}
          </m.div>
        ) : null}
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
            className="drop-glow-royal text-[28vmin] font-black text-ink"
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
            className="drop-glow-correct text-[22vmin] font-black text-correct-ink"
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
        fill={i % 2 ? '#ffeead' : '#ffc58f'}
        opacity={0.95 - i * 0.08}
      />
    ));
  return (
    <svg viewBox="-160 -110 320 220" className="drop-glow-shield h-full w-full" aria-hidden>
      <g transform="translate(0 -6)">
        <g className="origin-center">{feathers(-1)}</g>
        <g>{feathers(1)}</g>
      </g>
      <ellipse cx="0" cy="-58" rx="22" ry="6" fill="none" stroke="#ffeead" strokeWidth="4" />
      <circle cx="0" cy="-34" r="16" fill="#ffffff" />
      <path d="M-20 -14 L20 -14 L30 60 L-30 60 Z" fill="#bbdaff" />
      <path d="M-30 60 L30 60 L22 72 L-22 72 Z" fill="#ffc58f" />
      <circle cx="-5" cy="-36" r="2" fill="#001733" />
      <circle cx="5" cy="-36" r="2" fill="#001733" />
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
              className="drop-glow-shield absolute text-5xl font-black text-shield-ink sm:text-7xl"
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
