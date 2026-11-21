'use client';

import { useShallow } from 'zustand/react/shallow';
import { attackerCount } from '@/lib/engine/pairing';
import { isBattleRoyale } from '@/lib/engine/state';
import { arenaCounts, findPlayer } from '@/lib/client/players';
import { myPlayer, targetOf, useRoom } from '@/lib/client/store';
import { useRoomClient } from './RoomContext';

/**
 * Battle royale status strip (3+ players):
 *  - YOUR shortlist of up to 3 opponents (random and personal to you) — click one, or press 1–3,
 *    to choose whom you attack;
 *  - how many players have chosen to hunt you;
 *  - how the arena stands.
 * One compact line, so the fit system keeps the boards as large as possible.
 */
export function ArenaBar() {
  const client = useRoomClient();
  const { game, me, target } = useRoom(
    useShallow((s) => ({ game: s.game, me: myPlayer(s), target: targetOf(s) })),
  );
  if (!game || !isBattleRoyale(game.players.length)) return null;
  const players = game.players;
  const options = me?.targetOptions ?? [];
  const { alive, shielded, out } = arenaCounts(players);
  const hunters = me && me.status !== 'eliminated' ? attackerCount(players, me.id) : 0;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 pb-1 text-[clamp(11px,1.6vmin,14px)] font-bold text-muted"
      data-testid="arena-bar"
    >
      {me && me.status !== 'eliminated' && options.length > 0 && (
        <span className="flex min-w-0 items-center gap-1" role="group" aria-label="Choose whom to attack">
          <span aria-hidden>🎯</span>
          {options.map((id, i) => {
            const p = findPlayer(players, id);
            const selected = target?.id === id;
            return (
              <button
                key={id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => client.chooseTarget(id)}
                aria-pressed={selected}
                title={`Attack ${p?.nickname ?? '?'} (key ${i + 1})`}
                className={`max-w-[28vw] truncate rounded-full border px-2 py-0.5 transition sm:max-w-[10rem] ${
                  selected
                    ? 'border-steal bg-steal text-on-accent'
                    : 'border-line bg-panel/80 text-ink hover:border-steal-ink/70'
                }`}
                data-testid="target-option"
              >
                <span className="opacity-60">{i + 1}</span> {p?.nickname ?? '?'}
                <span className="ml-1 opacity-70 tabular-nums">{p?.rowsUsed ?? 0}/{p?.rowLimit ?? 0}</span>
              </button>
            );
          })}
        </span>
      )}
      {me && me.status !== 'eliminated' && options.length === 0 && (
        <span>🎯 <span className="text-ink">no one left to attack</span></span>
      )}
      {me && me.status !== 'eliminated' && (
        <span className={hunters > 0 ? 'text-steal-ink' : ''}>⚔ {hunters} hunting you</span>
      )}
      <span className="whitespace-nowrap">
        <span className="text-correct-ink">{alive}</span> alive · <span className="text-shield-ink">{shielded}</span> 🛡 ·{' '}
        {out} out
      </span>
    </div>
  );
}
