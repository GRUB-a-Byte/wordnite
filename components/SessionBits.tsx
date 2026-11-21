'use client';

import { useShallow } from 'zustand/react/shallow';
import { useRoom } from '@/lib/client/store';
import { duelView, liveDuels, sessionCounts } from '@/lib/client/view';
import type { PublicDuel, PublicSessionState, SessionStanding } from '@/lib/engine/types';
import { Board, type ActiveRow } from './Board';
import { formatClock, useNow } from './hooks';

/** "Players left: n · Live duels: m" — only shown once a room has more than two players (FR-5.2). */
export function SessionCounts() {
  const counts = useRoom(useShallow((s) => (s.session ? sessionCounts(s.session) : null)));
  if (!counts || counts.total <= 2) return null;
  return (
    <span className="text-[11px] font-bold whitespace-nowrap text-muted sm:text-xs" data-testid="session-counts">
      Players left {counts.left}/{counts.total} · Live duels {counts.live}
    </span>
  );
}

/** A duel's own clock (each duel runs independently, KH-5). */
export function DuelClock({ duel }: { duel: PublicDuel }) {
  const offset = useRoom((s) => s.clockOffset);
  const now = useNow(250);
  if (duel.phaseEndsAt === undefined || now === 0) return <span className="text-xs text-muted">—</span>;
  const remaining = Math.max(0, duel.phaseEndsAt - (now + offset));
  if (duel.phase === 'COUNTDOWN') return <span className="text-xs font-black text-shield">Starting…</span>;
  const danger = remaining <= 20_000;
  return (
    <span className={`font-black tabular-nums ${danger ? 'text-steal' : 'text-ink'}`} data-testid="duel-clock">
      {duel.phase === 'OVERTIME' && <span className="mr-1 rounded bg-shield px-1 text-[9px] text-black uppercase">OT</span>}
      {formatClock(remaining)}
    </span>
  );
}

/** Closest race first: smallest gap in rows used, then least time left (FR-7.1 highlight). */
export function rankDuelsByTension(duels: readonly PublicDuel[]): PublicDuel[] {
  const gap = (d: PublicDuel) => Math.abs((d.players[0]?.rowsUsed ?? 0) - (d.players[1]?.rowsUsed ?? 0));
  return [...duels].sort((a, b) => gap(a) - gap(b) || (a.phaseEndsAt ?? Infinity) - (b.phaseEndsAt ?? Infinity));
}

function DuelCard({ session, duel, hot }: { session: PublicSessionState; duel: PublicDuel; hot: boolean }) {
  const drafts = useRoom((s) => s.drafts);
  const game = duelView(session, duel);
  const ghost = (playerId: string): ActiveRow | null => {
    const d = drafts[playerId];
    if (!d || d.matchNumber !== duel.number || !d.letters) return null;
    return { letters: d.letters, look: 'ghost', steal: d.mode === 'steal' };
  };
  const [left, right] = duel.players;
  return (
    <article
      className={`flex flex-col items-center gap-2 rounded-2xl border bg-panel/60 p-2 sm:p-3 ${
        hot ? 'border-shield shadow-[0_0_24px_rgb(251_191_36/0.25)]' : 'border-line'
      }`}
      data-testid={`duel-card-${duel.id}`}
    >
      <div className="flex w-full items-center justify-between gap-2 text-xs">
        {hot ? <span className="font-black tracking-widest text-shield uppercase">🔥 Closest</span> : <span />}
        <DuelClock duel={duel} />
      </div>
      <div className="flex items-start justify-center gap-2 sm:gap-3">
        {left && <Board player={left} game={game} viewer="spectator" variant="mini" active={ghost(left.id)} />}
        <span className="self-center text-sm font-black text-muted">VS</span>
        {right && <Board player={right} game={game} viewer="spectator" variant="mini" active={ghost(right.id)} />}
      </div>
    </article>
  );
}

/** Live duels as a responsive grid of cards (spectators, eliminated players, the waiting room). */
export function DuelGrid({ compact = false }: { compact?: boolean }) {
  const session = useRoom((s) => s.session);
  if (!session) return null;
  const live = rankDuelsByTension(liveDuels(session));
  const waiting = session.players.filter((p) => p.status === 'waiting');
  const between = session.players.filter((p) => p.status === 'hill_holder');
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {(waiting.length > 0 || between.length > 0) && (
        <div className="flex flex-wrap justify-center gap-2 text-xs">
          {waiting.map((p) => (
            <span key={p.id} className="rounded-full border border-royal/50 bg-royal/15 px-3 py-1 font-bold" data-testid="waiting-chip">
              ⏳ Waiting: {p.nickname} {p.streak > 0 ? `👑${p.streak}` : ''}
            </span>
          ))}
          {between.map((p) => (
            <span key={p.id} className="rounded-full border border-shield/50 bg-shield/10 px-3 py-1 font-bold text-shield">
              👑{p.streak} {p.nickname} — next duel soon
            </span>
          ))}
        </div>
      )}
      {live.length === 0 ? (
        <p className="py-6 text-sm text-muted">Next duel starting…</p>
      ) : (
        <div
          className={`grid w-full gap-3 ${compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'}`}
          data-testid="duel-grid"
        >
          {live.map((d, i) => (
            <DuelCard key={d.id} session={session} duel={d} hot={i === 0 && live.length > 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Final standings (FR-6.6): champion first, then reverse elimination order; ties share a rank. */
export function Standings({ standings, me }: { standings: readonly SessionStanding[]; me: string }) {
  return (
    <ol className="w-full max-w-md space-y-1.5" data-testid="standings">
      {standings.map((s) => (
        <li
          key={s.playerId}
          className={`flex items-center gap-3 rounded-xl px-3 py-2 ${s.playerId === me ? 'bg-royal/25' : 'bg-panel-2'}`}
        >
          <span className="w-10 text-right font-black tabular-nums text-muted">{s.rank === 1 ? '👑' : ordinal(s.rank)}</span>
          <span className="flex-1 truncate font-bold">
            {s.nickname}
            {s.playerId === me && <span className="ml-1 text-xs text-muted">(you)</span>}
          </span>
          <span className="text-xs text-muted">
            {s.streak} win{s.streak === 1 ? '' : 's'}
          </span>
        </li>
      ))}
    </ol>
  );
}
