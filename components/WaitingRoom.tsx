'use client';

import { useShallow } from 'zustand/react/shallow';
import { arenaCounts, matchups } from '@/lib/client/players';
import { myPlayer, useRoom } from '@/lib/client/store';
import type { PublicPlayer } from '@/lib/engine/types';
import { DebugPanel } from './DebugPanel';
import { RoomHeader } from './RoomHeader';
import { Toasts } from './Toasts';

function Who({ p, me, rows = true }: { p: PublicPlayer; me: string; rows?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate font-bold">
        {p.nickname}
        {p.id === me && <span className="ml-1 text-xs text-muted">(you)</span>}
      </span>
      {rows && (
        <span className="shrink-0 text-xs text-muted tabular-nums">
          {p.status === 'invulnerable' ? `🛡 ${p.solvedInRows}` : `${p.rowsUsed}/${p.rowLimit}`}
        </span>
      )}
    </span>
  );
}

/**
 * v1.1 WR-5 — the battle-royale waiting room. A player with no opponent takes no action (WR-1), so
 * this screen has NO board, NO keyboard and NO timer: just who is still in the battle and which
 * duels are running. The game view comes back (with a blank board, FD-1) once the referee pairs them.
 */
export function WaitingRoom() {
  const { game, me } = useRoom(useShallow((s) => ({ game: s.game, me: myPlayer(s) })));
  if (!game || !me) return null;
  const { alive, shielded, out } = arenaCounts(game.players);
  const { duels, waiting } = matchups(game.players);
  // Eliminated players keep their last opponent, so this says whether I just won a duel.
  const wonDuel = game.players.some((p) => p.status === 'eliminated' && p.targetId === me.id);
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <RoomHeader />
      <main className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col items-center gap-4 px-4 pb-4" data-testid="waiting-room">
        <section className="flex flex-col items-center gap-1 pt-4 text-center">
          <span className="h-9 w-9 animate-spin rounded-full border-4 border-line border-t-royal" aria-hidden />
          <h1 className="text-2xl font-black sm:text-3xl">Waiting for an opponent</h1>
          <p className="text-sm text-muted" aria-live="polite">
            {wonDuel
              ? 'You won your duel! You’ll be paired as soon as someone is free — with a fresh word and a blank board.'
              : 'You’ll be paired as soon as a duel ends — with a fresh word and a blank board.'}
          </p>
        </section>

        <p className="text-sm font-bold whitespace-nowrap text-muted" data-testid="waiting-counts">
          <span className="text-correct-ink">{alive}</span> alive · <span className="text-shield-ink">{shielded}</span> 🛡 · {out} out
        </p>

        <section className="flex min-h-0 w-full flex-1 flex-col gap-2">
          <h2 className="text-xs font-bold tracking-[0.25em] text-muted uppercase">Still in the battle</h2>
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1" data-testid="matchups">
            {duels.map(([a, b]) => (
              <li
                key={`${a.id}-${b.id}`}
                className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl bg-panel-2 px-3 py-2 text-sm"
                data-testid="matchup"
              >
                <Who p={a} me={me.id} />
                <span className="text-xs font-black text-steal-ink">vs</span>
                <span className="justify-self-end">
                  <Who p={b} me={me.id} />
                </span>
              </li>
            ))}
            {waiting.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm"
                data-testid="matchup-waiting"
              >
                <Who p={p} me={me.id} rows={false /* their last duel's rows are history */} />
                <span className="text-xs font-bold text-muted">⏳ waiting</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Toasts />
      <DebugPanel />
    </div>
  );
}
