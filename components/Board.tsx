'use client';

import { m } from 'motion/react';
import type { PublicGameState, PublicPlayer } from '@/lib/engine/types';
import { nicknameOf } from '@/lib/client/players';
import { hasAmmoTray } from './fit';
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
  /** 'fit' = sized by the surrounding .fit-row (game / spectator); 'end' = fixed small size. */
  variant?: 'fit' | 'end';
  /** What to show in the row currently being typed (draft / pending / mirrored draft). */
  active?: ActiveRow | null;
  /** This board is the current steal target (FR-4.1 crosshair glow). */
  targeted?: boolean;
  onActivate?: () => void;
  /** Can the viewer click this board to attack it? (FR-4.4) */
  attackable?: boolean;
  overlays?: boolean;
  revealedSecret?: string;
}

function StatusPill({ player }: { player: PublicPlayer }) {
  const map = {
    alive: ['Alive', 'bg-correct'],
    invulnerable: ['🛡 Shielded', 'bg-shield'],
    eliminated: ['Out', 'bg-steal'],
  } as const;
  const [text, cls] = map[player.status];
  return (
    <span
      className={`rounded-full px-[0.6em] py-[0.1em] leading-tight font-black tracking-wide whitespace-nowrap text-on-accent uppercase ${cls}`}
    >
      {text}
    </span>
  );
}

function AmmoPips({ left, total }: { left: number; total: number }) {
  return (
    <span className="flex items-center gap-[0.15em]" aria-label={`${left} of ${total} steal shots left`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-[0.95em] w-[0.5em] rounded-sm ${i < left ? 'bg-steal glow-steal-sm' : 'bg-line'}`}
        />
      ))}
    </span>
  );
}

/**
 * One player's board. The header is ALWAYS exactly two lines of fixed height (--bh), and boards
 * carry no footers, so two boards side by side line up row for row on every screen size.
 */
export function Board({
  player,
  game,
  viewer,
  variant = 'fit',
  active,
  targeted,
  onActivate,
  attackable,
  overlays = true,
  revealedSecret,
}: BoardProps) {
  const { settings } = game;
  const len = settings.wordLength;
  const scoring = player.rows.filter((r) => r.scoring);
  const ammo = player.rows.filter((r) => !r.scoring);
  const nameOf = (id: string) => nicknameOf(game.players, id);
  const solved = player.status === 'invulnerable' || player.solvedInRows !== undefined;
  const showTray = hasAmmoTray(player);
  const activeInGrid = active && player.status === 'alive' && scoring.length < player.rowLimit;
  const activeInTray = active && player.status === 'invulnerable' && player.postSolveStealRows > 0;
  const shieldedForViewer = viewer !== 'me' && player.status === 'invulnerable';

  const stolen = useLatestFx('STEAL_HIT', (e) => e.targetId === player.id);
  const attacked = useLatestFx('STEAL_MISS', (e) => e.targetId === player.id);

  const interactive = !!onActivate;

  // Clicking a board is a pointer shortcut for the mode buttons (which stay keyboard-accessible,
  // as do Tab / Esc). It is a div, not a <button>, because Space / Enter are game keys.
  return (
    <div
      onClick={onActivate}
      aria-label={interactive && attackable ? `${player.nickname}'s board — click to steal` : `${player.nickname}'s board`}
      role="group"
      data-testid={`board-${player.id}`}
      data-status={player.status}
      className={[
        variant === 'end' ? 'board-end' : '',
        'board-pad relative flex shrink-0 flex-col items-center rounded-2xl border bg-panel/85 text-left shadow-sm transition',
        targeted ? 'steal-glow border-steal-ink' : 'border-line',
        player.status === 'invulnerable' ? 'shield-glow' : '',
        interactive && attackable && !targeted ? 'cursor-crosshair hover:border-steal-ink/70' : '',
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

      {/* FR-5.2 header — two fixed lines: name + rows used / status + solved + ammo */}
      <div className="flex h-[var(--bh)] w-full flex-col justify-center gap-[0.2em] overflow-hidden">
        <div className="flex min-w-0 items-center justify-between gap-1 text-[length:var(--bh-name)] leading-tight">
          <span className="flex min-w-0 items-center gap-1 font-black" data-testid="board-name">
            {player.isHost && (
              <span aria-label="host" title="Host" className="text-shield-ink">
                ★
              </span>
            )}
            <span className="truncate">
              {viewer === 'me' ? 'YOU · ' : ''}
              {player.nickname}
            </span>
          </span>
          <span className="shrink-0 font-bold text-muted tabular-nums" data-testid="rows-used">
            {player.rowsUsed}/{player.rowLimit}
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-1 text-[length:var(--bh-meta)] leading-tight">
          <StatusPill player={player} />
          <span className="flex shrink-0 items-center gap-[0.35em]">
            {!player.connected && (
              <span className="rounded bg-steal px-[0.35em] font-black text-on-accent uppercase">offline</span>
            )}
            {player.solvedInRows !== undefined && (
              <span className="font-black text-shield-ink" title={`Solved in ${player.solvedInRows} rows`}>
                ✓{player.solvedInRows}
              </span>
            )}
            {solved && <AmmoPips left={player.postSolveStealRows} total={settings.postSolveStealRows} />}
          </span>
        </div>
      </div>

      <div
        className={`tile-gap relative mt-[var(--head-gap,6px)] flex flex-col ${
          player.status === 'eliminated' ? 'eliminated' : ''
        } ${shieldedForViewer ? 'opacity-80 saturate-[.65]' : ''}`}
      >
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

      {/* UI-3 ammo tray: post-solve steal rows (its fixed chrome is --tray-chrome in globals.css) */}
      {showTray && (
        <div className="mt-2 flex flex-col items-center border-t border-dashed border-shield-ink/50 pt-1.5">
          <span className="mb-1.5 h-[14px] text-[10px] leading-[14px] font-bold tracking-widest text-shield-ink uppercase">
            ⚔ Ammo
          </span>
          <div className="tile-gap flex flex-col">
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
        </div>
      )}

      {revealedSecret && (
        <div className="mt-2 flex flex-col items-center gap-1">
          <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Secret word</span>
          <span className="rounded-lg bg-royal px-3 py-1 font-black tracking-[0.3em] text-on-accent" data-testid="revealed-secret">
            {revealedSecret}
          </span>
        </div>
      )}

      {/* UI-8 eliminated */}
      {player.status === 'eliminated' && (
        <div className="cracked pointer-events-none absolute inset-0 grid place-items-center rounded-2xl">
          <span className="-rotate-12 rounded-lg border-[3px] border-steal-ink bg-panel/70 px-[0.35em] py-[0.1em] text-[calc(var(--tile-size,var(--tile))*0.5)] font-black tracking-widest text-steal-ink uppercase">
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
          className="pointer-events-none absolute -top-3 left-1/2 z-20 max-w-[95%] -translate-x-1/2 truncate rounded-lg bg-steal px-2 py-0.5 text-[length:var(--bh-meta)] font-black whitespace-nowrap text-on-accent shadow-lg"
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
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-steal px-[0.4em] py-[0.15em] text-[calc(var(--tile-size,var(--tile))*0.75)] font-black tracking-widest text-on-accent shadow-2xl"
        initial={{ scale: 2.4, opacity: 0, rotate: -18 }}
        animate={{ scale: 1, opacity: 1, rotate: -8 }}
        transition={{ type: 'spring', stiffness: 380, damping: 16 }}
      >
        STOLEN!
      </m.span>
    </div>
  );
}
