'use client';

import { rankSolvers } from '@/lib/engine/outcome';
import type { PublicGameState, PublicPlayer } from '@/lib/engine/types';
import { ARENA_GAP, MINI_HEADER, MINI_PAD, MINI_TILE_GAP, bestGrid } from '@/lib/client/arenaLayout';
import { clockOf } from '@/lib/client/clock';
import { nicknameOf } from '@/lib/client/players';
import { useRoom } from '@/lib/client/store';
import { formatClock, useElementSize, useNow } from './hooks';

/** v1.1 FD-7: a duel's own clock on its two mini boards ("3…", "1:42", "OT 0:31", "⏳" waiting). */
function duelClockText(game: PublicGameState, p: PublicPlayer, hostNow: number): string | null {
  if (p.status === 'eliminated') return null;
  const c = clockOf(game, p);
  if (!c.phase || c.endsAt === undefined) return game.phase === 'PLAYING' ? '⏳' : null;
  const left = Math.max(0, c.endsAt - hostNow);
  if (c.phase === 'COUNTDOWN') return `${Math.max(1, Math.ceil(left / 1000))}…`;
  return `${c.phase === 'OVERTIME' ? 'OT ' : ''}${formatClock(left)}`;
}

function MiniBoard({
  p,
  tile,
  leader,
  nameOf,
  clock,
}: {
  p: PublicPlayer;
  tile: number;
  leader: boolean;
  nameOf: (id?: string) => string;
  clock: string | null;
}) {
  const scoring = p.rows.filter((r) => r.scoring);
  const letters = tile >= 18;
  const gap = Math.max(1, Math.round(tile * MINI_TILE_GAP));
  const status =
    p.status === 'eliminated'
      ? `out${p.eliminationReason === 'stolen' ? ` — stolen by ${nameOf(p.eliminatedBy)}` : p.eliminationReason === 'outscored' ? ' — out-scored' : p.eliminationReason === 'duel_draw' ? ' — duel drawn' : ''}`
      : p.status === 'invulnerable'
        ? `shielded, solved in ${p.solvedInRows}`
        : 'alive';
  return (
    <div
      className={`flex flex-col items-center rounded-lg border bg-panel/85 ${
        p.status === 'invulnerable' ? 'shield-glow border-shield-ink' : 'border-line'
      } ${p.status === 'eliminated' ? 'opacity-45 grayscale' : ''}`}
      style={{ padding: `0 ${tile * MINI_PAD}px ${tile * MINI_PAD}px` }}
      title={`${p.nickname}: ${status}`}
      data-testid={`mini-${p.id}`}
    >
      <div className="flex w-full items-center gap-1 overflow-hidden text-[11px] leading-[18px] font-bold" style={{ height: MINI_HEADER }}>
        <span className="shrink-0">{leader ? '👑' : p.status === 'eliminated' ? '✖' : p.status === 'invulnerable' ? '🛡' : ''}</span>
        <span className="min-w-0 flex-1 truncate">{p.nickname}</span>
        {clock && (
          <span className="shrink-0 text-steal-ink tabular-nums" data-testid="duel-clock">
            {clock}
          </span>
        )}
        <span className="shrink-0 text-muted tabular-nums">
          {p.solvedInRows ?? p.rowsUsed}/{p.rowLimit}
        </span>
      </div>
      <div className="flex flex-col" style={{ gap }}>
        {Array.from({ length: p.rowLimit }, (_, i) => {
          const row = scoring[i];
          return (
            <div key={i} className="flex" style={{ gap }}>
              {Array.from({ length: 5 }, (_, j) => {
                const state = row?.tiles[j];
                return (
                  <span
                    key={j}
                    className={`grid place-items-center rounded-[2px] font-black ${
                      state ? `tile-${state}` : 'border border-[var(--tile-border)] bg-[var(--tile-empty)]'
                    } ${row?.kind === 'steal' ? 'outline outline-1 outline-steal-ink' : ''}`}
                    style={{ width: tile, height: tile, fontSize: tile * 0.55 }}
                  >
                    {letters ? row?.word[j] : null}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Spectator / projector view of a battle royale: every player's board at once, packed into the
 * grid that gives the largest tiles for this screen (re-computed live on resize). Letters appear
 * once tiles are big enough to read; below that the colour patterns tell the story.
 */
export function ArenaGrid({ game }: { game: PublicGameState }) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const offset = useRoom((s) => s.clockOffset);
  const now = useNow(500);
  const hostNow = now + offset;
  const players = game.players;
  const rows = Math.max(...players.map((p) => p.rowLimit));
  const { cols, tile } = bestGrid(players.length, size.w, size.h, rows);
  const leader = rankSolvers(players.filter((p) => p.status === 'invulnerable'))[0]?.id;
  const nameOf = (id?: string) => nicknameOf(players, id);
  return (
    <div ref={ref} className="min-h-0 w-full flex-1 overflow-hidden" data-testid="arena-grid">
      {size.w > 0 && (
        <div
          className="mx-auto grid w-fit content-center justify-center"
          style={{ gridTemplateColumns: `repeat(${cols}, max-content)`, gap: ARENA_GAP }}
        >
          {players.map((p) => (
            <MiniBoard
              key={p.id}
              p={p}
              tile={tile}
              leader={p.id === leader}
              nameOf={nameOf}
              clock={now === 0 ? null : duelClockText(game, p, hostNow)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
