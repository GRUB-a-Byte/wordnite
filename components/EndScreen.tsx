'use client';

import { m } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { explainResult, perspectiveOf, REASON_TEXT } from '@/lib/client/copy';
import { useRoom } from '@/lib/client/store';
import { Board } from './Board';
import { DebugPanel } from './DebugPanel';
import { RoomHeader } from './RoomHeader';
import { useRoomClient } from './RoomContext';
import { ordinal, Standings } from './SessionBits';
import { Toasts } from './Toasts';

const HEADLINE = {
  win: ['You win!', 'from-correct to-royal-2'],
  lose: ['You lose', 'from-steal to-fuchsia-500'],
  draw: ['Draw', 'from-shield to-orange-500'],
  spectator: ['Match over', 'from-royal to-royal-2'],
  abandoned: ['Abandoned', 'from-muted to-line'],
} as const;

/**
 * FR-6.1 … FR-6.4, and FR-6.6 (v1.1 session end). With two players this is exactly the 1.0 end
 * screen (KH-14); with more it leads with the champion and the final standings.
 */
export function EndScreen() {
  const client = useRoomClient();
  const router = useRouter();
  const { game, session, me } = useRoom(useShallow((s) => ({ game: s.game, session: s.session, me: s.me })));
  const isPlayer = !!game?.players.some((p) => p.id === me);
  const [busy, setBusy] = useState(false);
  const multi = (session?.players.length ?? 0) > 2;
  const sessionResult = session?.result;
  const self = session?.players.find((p) => p.id === me);
  const isChampion = !!sessionResult?.championId && sessionResult.championId === me;
  const perspective = multi
    ? isChampion
      ? 'win'
      : sessionResult?.outcome === 'draw'
        ? 'draw'
        : self
          ? 'lose'
          : 'spectator'
    : game
      ? perspectiveOf(game.result, me, isPlayer)
      : 'abandoned';

  useEffect(() => {
    if (perspective !== 'win') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;
    void import('canvas-confetti').then(({ default: confetti }) => {
      if (cancelled) return;
      confetti({ particleCount: 140, spread: 80, origin: { y: 0.35 }, colors: ['#14b8a6', '#f59e0b', '#8b5cf6', '#22d3ee'] });
    });
    return () => {
      cancelled = true;
    };
  }, [perspective]);

  if (!session || (!multi && !game?.result)) return null;
  const result = game?.result;
  const isHost = session.hostId === me;
  const [baseHeadline, gradient] = HEADLINE[perspective];
  let headline: string = baseHeadline;
  const championName = session.players.find((p) => p.id === sessionResult?.championId)?.nickname;
  if (multi) {
    if (perspective === 'win') headline = 'Champion!';
    else if (perspective === 'lose') headline = `Knocked out — ${ordinal(self?.rank ?? session.players.length)}`;
    else if (perspective === 'spectator') headline = 'Session over';
  }
  const winnerName = multi ? championName : game?.players.find((p) => p.id === result?.winnerId)?.nickname;
  // KH-13: a new session needs at least two connected players (the 1.0 duel: both).
  const connectedPlayers = session.players.filter((p) => p.connected).length;
  const canRestart = multi ? connectedPlayers >= 2 : !!game?.players.every((p) => p.connected);
  const duration =
    game?.playStartedAt && game.finishedAt ? Math.max(0, Math.round((game.finishedAt - game.playStartedAt) / 1000)) : null;
  // Own board on the left for players.
  const players = game?.players ?? [];
  const ordered = isPlayer ? [...players.filter((p) => p.id === me), ...players.filter((p) => p.id !== me)] : players;

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
            className={`bg-gradient-to-r bg-clip-text text-5xl font-black text-transparent sm:text-7xl ${gradient}`}
            data-testid="end-headline"
          >
            {headline}
          </h1>
          {perspective === 'spectator' && winnerName && (
            <p className="text-xl font-black">{multi ? `👑 ${winnerName} is champion` : `${winnerName} wins`}</p>
          )}
          {multi && perspective === 'lose' && championName && (
            <p className="text-xl font-black">👑 {championName} is champion</p>
          )}
          {multi && sessionResult?.outcome === 'draw' && (
            <p className="text-lg font-bold">The final duel was a draw — nobody takes the hill.</p>
          )}
          {result && (
            <>
              <p className="text-lg font-bold text-ink" data-testid="end-reason">
                {multi ? 'Final duel: ' : ''}
                {REASON_TEXT[result.reason]}
              </p>
              <p className="max-w-lg text-sm text-muted">{explainResult(result, players, me)}</p>
            </>
          )}
          {duration !== null && <p className="text-xs text-muted">Match length {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, '0')}</p>}
        </m.div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {isHost ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setBusy(true);
                  client.rematch();
                  setTimeout(() => setBusy(false), 3000);
                }}
                disabled={busy || !canRestart}
                className="rounded-xl bg-gradient-to-r from-correct to-royal-2 px-6 py-3 text-lg font-black text-night shadow-lg hover:brightness-110 disabled:opacity-40"
                data-testid="rematch"
              >
                {multi ? 'New session' : 'Rematch'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setBusy(true);
                  client.returnToLobby();
                  setTimeout(() => setBusy(false), 3000);
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
              Waiting for host…
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
        {isHost && !canRestart && <p className="text-sm text-muted">Opponent left — go back to the lobby for a new challenger.</p>}

        {multi && sessionResult && <Standings standings={sessionResult.standings} me={me} />}

        <div className="flex w-full flex-wrap items-start justify-center gap-3 sm:gap-6">
          {ordered.map((p) => (
            <Board
              key={p.id}
              player={p}
              game={game!}
              viewer={p.id === me ? 'me' : 'spectator'}
              variant="end"
              overlays={false}
              revealedSecret={game?.revealedSecrets?.[p.id]}
            />
          ))}
        </div>
      </main>
      <Toasts />
      <DebugPanel />
    </div>
  );
}
