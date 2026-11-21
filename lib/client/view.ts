import { RESULT_HOLD_MS } from '@/lib/engine/project';
import { isActivePhase } from '@/lib/engine/state';
import type {
  GameEvent,
  PublicDuel,
  PublicGameState,
  PublicPlayer,
  PublicSessionState,
  RoomEvent,
  SessionPlayer,
} from '@/lib/engine/types';

/**
 * v1.1: which screen a viewer is on, and which duel (if any) they are looking at.
 *
 *  - lobby        seated players + spectators before START
 *  - duel         I am playing this duel (GameView)
 *  - duel_result  my duel just ended: winner/loser card for the result beat (FR-6.5)
 *  - waiting      I am in the waiting room (FR-8.1)
 *  - watch        I am watching the only live duel (1.0 spectator view, FR-7.1)
 *  - grid         I am watching several live duels (FR-7.1 multi-duel grid)
 *  - finished     the session is over (FR-6.6; with 2 players the 1.0 end screen)
 *  - abandoned    the host left (GR-36)
 */
export type ViewKind = 'none' | 'lobby' | 'duel' | 'duel_result' | 'waiting' | 'watch' | 'grid' | 'finished' | 'abandoned';

export interface RoomView {
  kind: ViewKind;
  /** The 1.0-shaped state of the duel on screen (or the lobby roster); null for waiting / grid. */
  game: PublicGameState | null;
  duelId?: string;
}

const DUEL_EVENT_TYPES = new Set<GameEvent['type']>([
  'MATCH_STARTED',
  'PLAY_STARTED',
  'ROW_ADDED',
  'SOLVED',
  'STEAL_MISS',
  'STEAL_HIT',
  'ELIMINATED',
  'OVERTIME_START',
  'FINISHED',
]);

export function isDuelEvent(e: RoomEvent): e is GameEvent & { duelId?: string } {
  return DUEL_EVENT_TYPES.has(e.type as GameEvent['type']);
}

/** A duel as a 1.0 `PublicGameState`, so every 1.0 component (boards, timer, overlays) just works. */
export function duelView(session: PublicSessionState, duel: PublicDuel): PublicGameState {
  return {
    roomCode: session.roomCode,
    version: session.version,
    hostId: session.hostId,
    hostNow: session.hostNow,
    phase: duel.phase,
    phaseEndsAt: duel.phaseEndsAt,
    overtimeUsed: duel.overtimeUsed,
    settings: session.settings,
    spectators: session.spectators,
    result: duel.result,
    lastEvents: session.lastEvents.filter((e): e is GameEvent & { duelId?: string } => isDuelEvent(e) && e.duelId === duel.id),
    matchNumber: duel.number,
    playStartedAt: duel.playStartedAt,
    finishedAt: duel.finishedAt,
    players: duel.players,
    revealedSecrets: duel.revealedSecrets,
  };
}

function rosterPlayer(p: SessionPlayer, baseRows: number): PublicPlayer {
  return {
    id: p.id,
    nickname: p.nickname,
    isHost: p.isHost,
    connected: p.connected,
    disconnectedAt: p.disconnectedAt,
    status: 'alive',
    rows: [],
    rowLimit: baseRows,
    rowsUsed: 0,
    postSolveStealRows: 0,
    lastSeq: p.lastSeq,
    streak: p.streak,
  };
}

/** Lobby / abandoned screens: the seated roster in 1.0 shape. */
export function rosterView(session: PublicSessionState): PublicGameState {
  return {
    roomCode: session.roomCode,
    version: session.version,
    hostId: session.hostId,
    hostNow: session.hostNow,
    phase: session.phase === 'ABANDONED' ? 'ABANDONED' : 'LOBBY',
    overtimeUsed: false,
    settings: session.settings,
    spectators: session.spectators,
    result: session.phase === 'ABANDONED' ? { outcome: 'abandoned', reason: 'abandoned' } : undefined,
    lastEvents: [],
    matchNumber: 0,
    players: session.players.map((p) => rosterPlayer(p, session.settings.baseRows)),
  };
}

export function liveDuels(session: PublicSessionState): PublicDuel[] {
  return session.duels.filter((d) => isActivePhase(d.phase));
}

/** Host-clock time until which a finished duel's result card is shown to its players. */
export function resultCardUntil(session: PublicSessionState, duel: PublicDuel): number {
  return (duel.finishedAt ?? 0) + session.settings.resultBeatMs + RESULT_HOLD_MS;
}

export interface SelectViewOptions {
  /** Estimated host time (Date.now() + clock offset). */
  hostNow: number;
  /** A duel whose result card the viewer dismissed with "Spectate" (FR-6.5). */
  dismissedDuelId?: string;
}

export function selectView(session: PublicSessionState | null, me: string, opts: SelectViewOptions): RoomView {
  if (!session) return { kind: 'none', game: null };
  if (session.phase === 'LOBBY') return { kind: 'lobby', game: rosterView(session) };
  if (session.phase === 'ABANDONED') return { kind: 'abandoned', game: rosterView(session) };

  const duelById = (id: string | undefined) => (id ? session.duels.find((d) => d.id === id) : undefined);
  const view = (kind: ViewKind, duel: PublicDuel): RoomView => ({ kind, game: duelView(session, duel), duelId: duel.id });

  if (session.phase === 'FINISHED') {
    const final = duelById(session.finalDuelId);
    return final ? view('finished', final) : { kind: 'finished', game: null };
  }

  const player = session.players.find((p) => p.id === me);
  const mine = duelById(player?.duelId);
  if (player && mine) {
    if (player.status === 'dueling') return view('duel', mine);
    if (player.status === 'hill_holder') return view('duel_result', mine);
    if (
      player.status === 'eliminated' &&
      mine.phase === 'FINISHED' &&
      opts.dismissedDuelId !== mine.id &&
      opts.hostNow < resultCardUntil(session, mine)
    ) {
      return view('duel_result', mine);
    }
  }
  if (player?.status === 'waiting') return { kind: 'waiting', game: null };

  // Spectators, eliminated players after their result card, and the referee host once knocked out.
  const live = liveDuels(session);
  if (live.length === 1) return view('watch', live[0] as PublicDuel);
  return { kind: 'grid', game: null };
}

/** Events relevant to what the viewer is looking at (overlays must not fire for other duels). */
export function eventsForView(events: readonly RoomEvent[], view: RoomView): RoomEvent[] {
  if (view.kind === 'grid' || view.kind === 'waiting' || !view.duelId) return [...events];
  return events.filter((e) => !('duelId' in e) || e.duelId === undefined || e.duelId === view.duelId);
}

/** "Players left: n · Live duels: m" (FR-5.2 amended). */
export function sessionCounts(session: PublicSessionState): { left: number; total: number; live: number } {
  return {
    left: session.players.filter((p) => p.status !== 'eliminated').length,
    total: session.players.length,
    live: liveDuels(session).length,
  };
}
