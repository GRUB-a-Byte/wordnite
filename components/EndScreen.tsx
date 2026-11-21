'use client';

import { m } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { explainResult, ordinal, perspectiveOf, placeOf, playerFate, reasonText } from '@/lib/client/copy';
import { isBattleRoyale, isWaitingForSeat, nextMatchSize, playersStillHere } from '@/lib/engine/state';
import { findPlayer } from '@/lib/client/players';
import { useRoom } from '@/lib/client/store';
import { Board } from './Board';
import { DebugPanel } from './DebugPanel';
import { RoomHeader } from './RoomHeader';
import { useRoomClient } from './RoomContext';
import { formatClock, useTemporaryFlag } from './hooks';
import { Toasts } from './Toasts';

const HEADLINE = {
  win: ['You win!', 'text-correct-ink'],
  lose: ['You lose', 'text-steal-ink'],
  draw: ['Draw', 'text-shield-ink'],
  spectator: ['Match over', 'text-blue-ink'],
  abandoned: ['Abandoned', 'text-muted'],
} as const;

/** Battle royale final standings: place, player, how they finished, secret word. */
function Standings({ game, me }: { game: NonNullable<ReturnType<typeof useRoom.getState>['game']>; me: string }) {
  const standings = game.result?.standings ?? [];
  const byId = new Map(game.players.map((p) => [p.id, p]));
  return (
    <section className="w-full max-w-2xl rounded-2xl border border-line bg-panel/80" data-testid="standings">
      <h2 className="border-b border-line px-4 py-2 text-xs font-bold tracking-[0.3em] text-muted uppercase">
        Final standings · {standings.length} players
      </h2>
      <ol className="max-h-[40vh] overflow-y-auto">
        {standings.map(({ playerId, place }) => {
          const p = byId.get(playerId);
          if (!p) return null;
          return (
            <li
              key={playerId}
              className={`grid grid-cols-[3rem_1fr_auto] items-center gap-2 border-b border-line/40 px-4 py-1.5 text-sm last:border-0 ${
                playerId === me ? 'bg-blue/25 font-black' : ''
              }`}
            >
              <span className={`font-black tabular-nums ${place === 1 ? 'text-shield-ink' : 'text-muted'}`}>
                {place === 1 ? '👑 1' : ordinal(place)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-bold">
                  {p.nickname}
                  {playerId === me ? ' (you)' : ''}
                </span>
                <span className="block truncate text-xs text-muted">{playerFate(p, game.players)}</span>
              </span>
              <span className="font-mono text-xs font-bold tracking-widest text-muted">{game.revealedSecrets?.[playerId]}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** FR-6.1 … FR-6.4 */
export function EndScreen() {
  const client = useRoomClient();
  const router = useRouter();
  const { game, me } = useRoom(useShallow((s) => ({ game: s.game, me: s.me })));
  const isPlayer = !!game?.players.some((p) => p.id === me);
  const [busy, markBusy] = useTemporaryFlag(3000); // one click per action while the referee responds
  const perspective = game ? perspectiveOf(game.result, me, isPlayer) : 'abandoned';

  useEffect(() => {
    if (perspective !== 'win') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;
    void import('canvas-confetti').then(({ default: confetti }) => {
      if (cancelled) return;
      confetti({ particleCount: 140, spread: 80, origin: { y: 0.35 }, colors: ['#d1f1a9', '#ffc58f', '#ebbbff', '#99ffff', '#bbdaff', '#ffeead'] });
    });
    return () => {
      cancelled = true;
    };
  }, [perspective]);

  if (!game || !game.result) return null;
  const result = game.result;
  const isHost = game.hostId === me;
  const [headline, headlineColour] = HEADLINE[perspective];
  const winnerName = findPlayer(game.players, result.winnerId)?.nickname;
  const royale = isBattleRoyale(game.players.length);
  // Rematch = everyone still here + spectators waiting for a seat (capped) — the referee's own rule.
  const stillHere = playersStillHere(game.players, game.hostId).length;
  const waiting = game.spectators.filter(isWaitingForSeat).length;
  const nextSize = nextMatchSize(game);
  const canRematch = nextSize >= 2;
  const myPlace = placeOf(result, me);
  const durationMs = game.playStartedAt && game.finishedAt ? Math.max(0, game.finishedAt - game.playStartedAt) : null;
  // Boards shown: a duel shows both (own on the left); a battle royale shows yours and the winner's.
  const ordered = royale
    ? [
        game.players.find((p) => isPlayer && p.id === me),
        game.players.find((p) => p.id === result.winnerId && p.id !== me),
      ].filter((p): p is NonNullable<typeof p> => !!p)
    : isPlayer
      ? [...game.players.filter((p) => p.id === me), ...game.players.filter((p) => p.id !== me)]
      : game.players;
  const meSpectating = game.spectators.find((sp) => sp.id === me);

  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center gap-5 px-3 pb-10">
        <m.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex flex-col items-center gap-1 text-center"
          data-testid="end-screen"
        >
          <h1
            className={`text-5xl font-black sm:text-7xl ${headlineColour}`}
            data-testid="end-headline"
          >
            {headline}
          </h1>
          {perspective === 'spectator' && winnerName && <p className="text-xl font-black">{winnerName} wins</p>}
          {royale && isPlayer && myPlace && perspective !== 'win' && (
            <p className="text-2xl font-black text-ink" data-testid="end-place">
              {ordinal(myPlace)} of {game.players.length}
            </p>
          )}
          <p className="text-lg font-bold text-ink" data-testid="end-reason">
            {reasonText(result, game.players.length)}
          </p>
          <p className="max-w-lg text-sm text-muted">{explainResult(result, game.players, me)}</p>
          {durationMs !== null && <p className="text-xs text-muted">Match length {formatClock(Math.round(durationMs / 1000) * 1000)}</p>}
        </m.div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {isHost ? (
            <>
              <button
                type="button"
                onClick={() => {
                  markBusy();
                  client.rematch();
                }}
                disabled={busy || !canRematch}
                title={canRematch ? `Start the next match with ${nextSize} players` : 'Need at least 2 players'}
                className="rounded-xl bg-gradient-to-r from-correct to-royal-2 px-6 py-3 text-lg font-black text-on-accent shadow-lg hover:brightness-110 disabled:opacity-40"
                data-testid="rematch"
              >
                Rematch
              </button>
              <button
                type="button"
                onClick={() => {
                  markBusy();
                  client.returnToLobby();
                }}
                disabled={busy}
                className="rounded-xl border border-line px-5 py-3 font-bold text-muted hover:text-ink"
                data-testid="back-to-lobby"
              >
                Back to lobby
              </button>
            </>
          ) : (
            <span className="rounded-xl bg-panel-2 px-5 py-3 font-bold text-muted" data-testid="waiting-rematch">
              {meSpectating?.wantsToPlay ? 'You’ll play in the next match — waiting for the host…' : 'Waiting for host…'}
            </span>
          )}
          <button
            type="button"
            onClick={() => router.push('/')}
            className="rounded-xl border border-line px-5 py-3 font-bold text-muted hover:text-ink"
          >
            Leave
          </button>
        </div>
        {isHost && (
          <p className="text-sm text-muted" data-testid="next-match-size">
            {canRematch
              ? `Next match: ${nextSize} player${nextSize === 1 ? '' : 's'}${waiting ? ` (incl. ${Math.min(waiting, nextSize - stillHere)} who were watching)` : ''}`
              : 'Everyone else left — wait for someone to join, or go back to the lobby.'}
          </p>
        )}

        {royale && <Standings game={game} me={me} />}

        <div className="flex w-full flex-wrap items-start justify-center gap-3 sm:gap-6">
          {ordered.map((p) => (
            <Board
              key={p.id}
              player={p}
              game={game}
              viewer={p.id === me ? 'me' : 'spectator'}
              variant="end"
              overlays={false}
              revealedSecret={game.revealedSecrets?.[p.id]}
            />
          ))}
        </div>
      </main>
      <Toasts />
      <DebugPanel />
    </div>
  );
}
