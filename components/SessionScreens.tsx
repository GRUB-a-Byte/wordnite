'use client';

import { m } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { explainResult, REASON_TEXT } from '@/lib/client/copy';
import { useRoom } from '@/lib/client/store';
import { liveDuels, resultCardUntil, sessionCounts } from '@/lib/client/view';
import { Board } from './Board';
import { DebugPanel } from './DebugPanel';
import { useNow } from './hooks';
import { RoomHeader } from './RoomHeader';
import { useRoomClient } from './RoomContext';
import { DuelGrid, ordinal, SessionCounts } from './SessionBits';
import { Toasts } from './Toasts';

function useHostNow(intervalMs = 250): number {
  const offset = useRoom((s) => s.clockOffset);
  const now = useNow(intervalMs);
  return now === 0 ? 0 : now + offset;
}

/** FR-8.1 waiting room: streak, players left, live mini-view of the duels in progress. */
export function WaitingRoom() {
  const { session, me } = useRoom(useShallow((s) => ({ session: s.session, me: s.me })));
  if (!session) return null;
  const self = session.players.find((p) => p.id === me);
  const counts = sessionCounts(session);
  const live = liveDuels(session);
  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center gap-5 px-3 pb-8">
        <m.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-2 text-center"
          data-testid="waiting-room"
        >
          <span className="h-10 w-10 animate-spin rounded-full border-4 border-line border-t-royal" aria-hidden />
          <h1 className="text-3xl font-black sm:text-4xl">Waiting for a challenger…</h1>
          <p className="text-muted" aria-live="polite">
            {live.length > 0
              ? `You’ll face the winner of ${live.length === 1 ? 'the duel below' : 'one of the duels below'}.`
              : 'Your next opponent is on the way.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2 text-sm font-bold">
            {(self?.streak ?? 0) > 0 && (
              <span className="rounded-full bg-shield/20 px-3 py-1 text-shield" data-testid="my-streak">
                👑 Streak {self?.streak}
              </span>
            )}
            <span className="rounded-full bg-panel-2 px-3 py-1">
              Players left {counts.left}/{counts.total}
            </span>
          </div>
        </m.section>
        <DuelGrid compact />
      </main>
      <Toasts />
      <DebugPanel />
    </div>
  );
}

/** FR-7.1 multi-duel spectator grid (spectators, knocked-out players, a knocked-out host). */
export function GridView() {
  const { session, me } = useRoom(useShallow((s) => ({ session: s.session, me: s.me })));
  if (!session) return null;
  const self = session.players.find((p) => p.id === me);
  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader
        center={
          <span className="flex items-center gap-3">
            <span className="text-xs font-bold tracking-widest text-muted uppercase">Spectating</span>
            <SessionCounts />
          </span>
        }
      />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center gap-4 px-3 pb-8" data-testid="grid-view">
        {self?.status === 'eliminated' && (
          <p className="rounded-full bg-steal/15 px-4 py-1.5 text-sm font-bold text-steal">
            Knocked out — {ordinal(self.rank ?? session.players.length)} of {session.players.length}
          </p>
        )}
        <DuelGrid />
        <p className="text-xs text-muted">{session.spectators.filter((s) => s.connected).length} watching</p>
      </main>
      <Toasts />
      <DebugPanel />
    </div>
  );
}

/**
 * FR-6.5 duel-end interstitial, shown during the result beat (KH-9). Reuses the 1.0 end screen's
 * content: outcome, reason, both boards with revealed secrets.
 */
export function DuelResult() {
  const client = useRoomClient();
  const router = useRouter();
  const { game, session, me } = useRoom(useShallow((s) => ({ game: s.game, session: s.session, me: s.me })));
  const hostNow = useHostNow();
  if (!game?.result || !session) return null;
  const result = game.result;
  const self = session.players.find((p) => p.id === me);
  const won = result.outcome === 'win' && result.winnerId === me;
  const draw = result.outcome === 'draw';
  const duel = session.duels.find((d) => d.number === game.matchNumber);
  const waiting = session.players.find((p) => p.status === 'waiting' && p.id !== me);
  const secondsLeft = (until: number | undefined) => (until && hostNow ? Math.max(0, Math.ceil((until - hostNow) / 1000)) : null);

  let headline: string;
  let gradient: string;
  if (won) [headline, gradient] = ['Victory!', 'from-correct to-royal-2'];
  else if (draw) [headline, gradient] = ['Draw — both out', 'from-shield to-orange-500'];
  else [headline, gradient] = ['Knocked out', 'from-steal to-fuchsia-500'];

  let next: React.ReactNode = null;
  if (won) {
    const s = secondsLeft(self?.availableAt);
    next = waiting ? (
      <p className="text-lg font-black" data-testid="next-challenger">
        New challenger: {waiting.nickname}
        {s !== null ? ` in ${s}s` : ''}
      </p>
    ) : (
      <p className="font-bold text-muted" data-testid="next-challenger">
        {liveDuels(session).length > 0 ? 'Next: you’ll wait for the winner of another duel.' : 'Next duel starting…'}
      </p>
    );
  }
  const s = duel ? secondsLeft(resultCardUntil(session, duel)) : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader center={<SessionCounts />} />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center gap-4 px-3 pb-10">
        <m.div
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex flex-col items-center gap-1 text-center"
          data-testid="duel-result"
        >
          <h1
            className={`bg-gradient-to-r bg-clip-text text-5xl font-black text-transparent sm:text-7xl ${gradient}`}
            data-testid="duel-result-headline"
          >
            {headline}
          </h1>
          <p className="text-lg font-bold" data-testid="duel-result-reason">
            {REASON_TEXT[result.reason]}
          </p>
          <p className="max-w-lg text-sm text-muted">{explainResult(result, game.players, me)}</p>
          {won && (
            <p className="mt-1 rounded-full bg-shield/20 px-3 py-1 text-sm font-black text-shield" data-testid="my-streak">
              👑 Streak {self?.streak ?? 1}
            </p>
          )}
          {!won && self?.status === 'eliminated' && (
            <p className="mt-1 text-xl font-black" data-testid="knocked-out-rank">
              {ordinal(self.rank ?? session.players.length)} of {session.players.length}
            </p>
          )}
          {next}
        </m.div>

        {!won && (
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => client.dismissResult()}
              className="rounded-xl bg-gradient-to-r from-royal to-royal-2 px-5 py-3 font-black text-night"
              data-testid="spectate"
            >
              Spectate{s !== null ? ` (${s})` : ''}
            </button>
            <button
              type="button"
              onClick={() => router.push('/')}
              className="rounded-xl border border-line px-5 py-3 font-bold text-muted hover:text-ink"
            >
              Leave
            </button>
          </div>
        )}

        <div className="flex w-full flex-wrap items-start justify-center gap-3 sm:gap-6">
          {[...game.players.filter((p) => p.id === me), ...game.players.filter((p) => p.id !== me)].map((p) => (
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
