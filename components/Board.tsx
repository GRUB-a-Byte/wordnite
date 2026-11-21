'use client';

import { m } from 'motion/react';
import type { PublicGameState, PublicPlayer } from '@/lib/engine/types';
import { useLatestFx } from './hooks';
import { OpenRow, ScoredRow } from './Row';

export interface ActiveRow {
  letters: string;
  look: 'typed' | 'ghost' | 'pending';
  steal: boolean;
  label?: string;
  shakeKey?: number;
}

interface BoardProps {
  player: PublicPlayer;
  game: PublicGameState;
  viewer: 'me' | 'opponent' | 'spectator';
  variant: 'mine' | 'opp' | 'large' | 'end';
  /** What to show in the row currently being typed (draft / pending / mirrored draft). */
  active?: ActiveRow | null;
  /** This board is the current steal target (FR-4.1 crosshair glow). */
  targeted?: boolean;
  onActivate?: () => void;
  /** Can the viewer click this board to attack it? (FR-4.4) */
  attackable?: boolean;
  footer?: React.ReactNode;
  overlays?: boolean;
  revealedSecret?: string;
}

function StatusPill({ player }: { player: PublicPlayer }) {
  const map = {
    alive: ['Alive', 'bg-correct/15 text-correct border-correct/40'],
    invulnerable: ['🛡 Shielded', 'bg-shield/15 text-shield border-shield/50'],
    eliminated: ['Eliminated', 'bg-steal/15 text-steal border-steal/40'],
  } as const;
  const [text, cls] = map[player.status];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase sm:text-xs ${cls}`}>
      {text}
    </span>
  );
}

function AmmoPips({ left, total }: { left: number; total: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${left} of ${total} steal shots left`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 w-1.5 rounded-sm sm:h-3 sm:w-2 ${i < left ? 'bg-steal shadow-[0_0_6px_rgb(244_63_94/0.8)]' : 'bg-line'}`}
        />
      ))}
    </span>
  );
}

export function Board({
  player,
  game,
  viewer,
  variant,
  active,
  targeted,
  onActivate,
  attackable,
  footer,
  overlays = true,
  revealedSecret,
}: BoardProps) {
  const { settings } = game;
  const len = settings.wordLength;
  const scoring = player.rows.filter((r) => r.scoring);
  const ammo = player.rows.filter((r) => !r.scoring);
  const nameOf = (id: string) => game.players.find((p) => p.id === id)?.nickname ?? '?';
  const solved = player.status === 'invulnerable' || player.solvedInRows !== undefined;
  const showTray = solved || ammo.length > 0;
  const activeInGrid = active && player.status === 'alive' && scoring.length < player.rowLimit;
  const activeInTray = active && player.status === 'invulnerable' && player.postSolveStealRows > 0;
  const shieldedForViewer = viewer !== 'me' && player.status === 'invulnerable';

  const stolen = useLatestFx('STEAL_HIT', (e) => e.targetId === player.id);
  const attacked = useLatestFx('STEAL_MISS', (e) => e.targetId === player.id);

  const sizeClass =
    variant === 'opp' ? 'board-opp' : variant === 'large' ? 'board-large' : variant === 'end' ? 'board-end' : 'board-mine';

  const interactive = !!onActivate;

  // Clicking a board is a pointer shortcut for the mode buttons (which stay keyboard-accessible,
  // as do Tab / Esc). It is a div, not a <button>, because the footer can contain a button and
  // Space / Enter are game keys.
  return (
    <div
      onClick={onActivate}
      aria-label={
        interactive
          ? attackable
            ? `${player.nickname}'s board — click to steal`
            : `${player.nickname}'s board`
          : `${player.nickname}'s board`
      }
      role="group"
      data-testid={`board-${player.id}`}
      data-status={player.status}
      className={[
        sizeClass,
        'relative flex flex-col items-center gap-2 rounded-2xl border bg-panel/70 px-[calc(var(--tile-size,var(--tile))*0.42)] pt-2 pb-3 text-left transition',
        targeted ? 'steal-glow border-steal' : 'border-line',
        player.status === 'invulnerable' ? 'shield-glow' : '',
        interactive && attackable && !targeted ? 'cursor-crosshair hover:border-steal/70' : '',
        interactive && !attackable ? (shieldedForViewer ? 'cursor-not-allowed' : 'cursor-pointer') : '',
      ].join(' ')}
    >
      {overlays && attacked && (
        <span
          key={`flash-${attacked.id}`}
          aria-hidden
          className="attack-flash pointer-events-none absolute inset-0 rounded-2xl"
        />
      )}
      {/* FR-5.2 board header */}
      <div className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {player.isHost && (
            <span aria-label="host" title="Host" className="text-shield">
              ★
            </span>
          )}
          <span className="truncate text-sm font-black sm:text-base" data-testid="board-name">
            {viewer === 'me' ? 'YOU · ' : ''}
            {player.nickname}
          </span>
          {!player.connected && (
            <span className="rounded bg-steal/20 px-1 text-[10px] font-bold text-steal uppercase">offline</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusPill player={player} />
          <span className="text-xs font-bold text-muted tabular-nums sm:text-sm" data-testid="rows-used">
            {player.rowsUsed}/{player.rowLimit}
          </span>
          {solved && <AmmoPips left={player.postSolveStealRows} total={settings.postSolveStealRows} />}
        </div>
      </div>

      {player.solvedInRows !== undefined && (
        <span className="rounded-full bg-shield/15 px-2 py-0.5 text-[11px] font-bold text-shield">
          Solved in {player.solvedInRows}
        </span>
      )}

      <div className={`relative flex flex-col gap-[var(--tile-gap)] ${player.status === 'eliminated' ? 'eliminated' : ''}`}>
        {Array.from({ length: player.rowLimit }, (_, i) => {
          const row = scoring[i];
          let content: React.ReactNode;
          if (row) {
            content = (
              <ScoredRow
                row={row}
                length={len}
                label={row.kind === 'steal' ? `→ ${nameOf(row.targetId)}` : undefined}
              />
            );
          } else if (i === scoring.length && activeInGrid) {
            content = (
              <OpenRow
                letters={active.letters}
                length={len}
                look={active.look}
                steal={active.steal}
                label={active.steal ? active.label : undefined}
                shakeKey={active.shakeKey}
              />
            );
          } else {
            content = <OpenRow letters="" length={len} look="empty" />;
          }
          // UI-3: the overtime rows animate in.
          return i >= settings.baseRows ? (
            <m.div key={i} initial={{ opacity: 0, y: -10, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }}>
              {content}
            </m.div>
          ) : (
            <div key={i}>{content}</div>
          );
        })}
      </div>

      {/* UI-3 ammo tray: post-solve steal rows */}
      {showTray && (
        <div className="flex flex-col items-center gap-[var(--tile-gap)] border-t border-dashed border-shield/40 pt-2">
          <span className="text-[10px] font-bold tracking-widest text-shield uppercase">⚔ Ammo tray</span>
          {Array.from({ length: settings.postSolveStealRows }, (_, i) => {
            const row = ammo[i];
            if (row) return <ScoredRow key={row.id} row={row} length={len} label={`→ ${nameOf(row.targetId)}`} />;
            if (i === ammo.length && activeInTray) {
              return (
                <OpenRow
                  key={`a${i}`}
                  letters={active.letters}
                  length={len}
                  look={active.look}
                  steal
                  label={active.label}
                  shakeKey={active.shakeKey}
                />
              );
            }
            return <OpenRow key={`a${i}`} letters="" length={len} look="empty" dashed />;
          })}
        </div>
      )}

      {revealedSecret && (
        <div className="mt-1 flex flex-col items-center gap-1">
          <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Secret word</span>
          <span className="rounded-lg bg-royal/20 px-3 py-1 font-black tracking-[0.3em] text-ink" data-testid="revealed-secret">
            {revealedSecret}
          </span>
        </div>
      )}

      {footer && <div className="w-full text-center text-xs text-muted">{footer}</div>}

      {/* UI-7: an opponent's shielded board is desaturated with a shield badge */}
      {shieldedForViewer && (
        <div className="pointer-events-none absolute inset-0 rounded-2xl bg-night/35 backdrop-saturate-50">
          <div className="shield-shimmer absolute inset-0 rounded-2xl" />
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-5xl drop-shadow-[0_0_12px_rgb(251_191_36/0.7)] sm:text-6xl">
            🛡️
          </span>
        </div>
      )}

      {/* UI-8 eliminated */}
      {player.status === 'eliminated' && (
        <div className="cracked pointer-events-none absolute inset-0 grid place-items-center rounded-2xl">
          <span className="-rotate-12 rounded-lg border-4 border-steal px-3 py-1 text-xl font-black tracking-widest text-steal uppercase opacity-90 sm:text-3xl">
            Eliminated
          </span>
        </div>
      )}

      {/* FR-4.6 "STOLEN!" shatter */}
      {overlays && stolen && <StolenOverlay key={`stolen-${stolen.id}`} />}

      {/* FR-4.5 attack flash */}
      {overlays && attacked && viewer === 'me' && (
        <m.div
          key={`atk-${attacked.id}`}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: [0, 1, 1, 0], y: 0 }}
          transition={{ duration: 1.6, times: [0, 0.1, 0.75, 1] }}
          className="pointer-events-none absolute -top-4 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-steal px-3 py-1 text-sm font-black whitespace-nowrap text-white shadow-lg"
          role="status"
        >
          ⚔ {nameOf(attacked.event.stealerId)} is attacking!
        </m.div>
      )}
    </div>
  );
}

const SHARDS = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * Math.PI * 2;
  return { x: Math.cos(angle) * 160, y: Math.sin(angle) * 160, r: (i % 2 ? 1 : -1) * (40 + i * 9) };
});

function StolenOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-visible">
      {SHARDS.map((s, i) => (
        <m.span
          key={i}
          className="absolute top-1/2 left-1/2 h-6 w-6 bg-steal/80"
          style={{ clipPath: 'polygon(50% 0, 100% 100%, 0 80%)' }}
          initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
          animate={{ x: s.x, y: s.y, rotate: s.r, opacity: 0 }}
          transition={{ duration: 1.1, ease: 'easeOut' }}
        />
      ))}
      <m.span
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-steal px-4 py-2 text-3xl font-black tracking-widest text-white shadow-2xl sm:text-5xl"
        initial={{ scale: 2.4, opacity: 0, rotate: -18 }}
        animate={{ scale: 1, opacity: 1, rotate: -8 }}
        transition={{ type: 'spring', stiffness: 380, damping: 16 }}
      >
        STOLEN!
      </m.span>
    </div>
  );
}
