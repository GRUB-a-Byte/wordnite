'use client';

import { useShallow } from 'zustand/react/shallow';
import { isBattleRoyale } from '@/lib/engine/state';
import { arenaCounts } from '@/lib/client/players';
import { myPlayer, targetOf, useRoom } from '@/lib/client/store';

/**
 * Battle royale status strip (3+ players):
 *  - YOUR opponent: the one player the referee paired you with at random (they fight only you,
 *    you fight only them), or that you're waiting for a free opponent;
 *  - how the arena stands.
 * One compact line, so the fit system keeps the boards as large as possible.
 */
export function ArenaBar() {
  const { game, me, opponent } = useRoom(
    useShallow((s) => ({ game: s.game, me: myPlayer(s), opponent: targetOf(s) })),
  );
  if (!game || !isBattleRoyale(game.players.length)) return null;
  const { alive, shielded, out } = arenaCounts(game.players);
  const inPlay = !!me && me.status !== 'eliminated';
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 pb-1 text-[clamp(11px,1.6vmin,14px)] font-bold text-muted"
      data-testid="arena-bar"
    >
      {inPlay && opponent && (
        <span className="flex min-w-0 items-center gap-1" data-testid="opponent">
          <span aria-hidden>⚔</span> Your opponent:
          <span className="max-w-[40vw] truncate text-steal-ink sm:max-w-[14rem]" data-testid="opponent-name">
            {opponent.nickname}
          </span>
          <span className="opacity-70 tabular-nums">
            {opponent.rowsUsed}/{opponent.rowLimit}
          </span>
        </span>
      )}
      {inPlay && !opponent && (
        <span data-testid="opponent">
          ⏳ <span className="text-ink">{me.status === 'alive' ? 'waiting for a free opponent' : 'no opponent left'}</span>
        </span>
      )}
      <span className="whitespace-nowrap">
        <span className="text-correct-ink">{alive}</span> alive · <span className="text-shield-ink">{shielded}</span> 🛡 ·{' '}
        {out} out
      </span>
    </div>
  );
}
