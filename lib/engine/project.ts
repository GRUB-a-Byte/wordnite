import { isActivePhase } from './state';
import type {
  PrivateDuel,
  PrivateGameState,
  PrivatePlayer,
  PrivateSessionState,
  PublicDuel,
  PublicGameState,
  PublicPlayer,
  PublicSessionState,
  Row,
  SessionPlayer,
} from './types';

/**
 * FIX 1 — the ONLY way state leaves the referee.
 *
 * Whitelist projection: every public field is copied explicitly, so a new private field added to
 * `PrivatePlayer` / `PrivateGameState` can never leak by accident. Secret words are omitted from
 * every player record and are only revealed (as `revealedSecrets`) once the match is FINISHED.
 */
export function toPublicState(s: PrivateGameState, hostNow: number): PublicGameState {
  const pub: PublicGameState = {
    roomCode: s.roomCode,
    version: s.version,
    hostId: s.hostId,
    hostNow,
    phase: s.phase,
    phaseEndsAt: s.phaseEndsAt,
    overtimeUsed: s.overtimeUsed,
    settings: { ...s.settings },
    players: s.players.map(toPublicPlayer),
    spectators: s.spectators.map((sp) => ({ ...sp })),
    result: s.result ? { ...s.result } : undefined,
    lastEvents: s.lastEvents.map((e) => ({ ...e })),
    matchNumber: s.matchNumber,
    playStartedAt: s.playStartedAt,
    finishedAt: s.finishedAt,
  };
  if (s.phase === 'FINISHED') {
    pub.revealedSecrets = Object.fromEntries(s.players.map((p) => [p.id, p.secret]));
  }
  return pub;
}

function copyRow(r: Row): Row {
  return {
    id: r.id,
    word: r.word,
    tiles: [...r.tiles],
    kind: r.kind,
    targetId: r.targetId,
    scoring: r.scoring,
    at: r.at,
    hit: r.hit,
  };
}

export function toPublicPlayer(p: PrivatePlayer): PublicPlayer {
  return {
    id: p.id,
    nickname: p.nickname,
    isHost: p.isHost,
    connected: p.connected,
    disconnectedAt: p.disconnectedAt,
    status: p.status,
    rows: p.rows.map(copyRow),
    rowLimit: p.rowLimit,
    rowsUsed: p.rowsUsed,
    postSolveStealRows: p.postSolveStealRows,
    solvedInRows: p.solvedInRows,
    solvedAt: p.solvedAt,
    solveOrder: p.solveOrder,
    eliminatedAt: p.eliminatedAt,
    eliminatedBy: p.eliminatedBy,
    eliminationReason: p.eliminationReason,
    targetId: p.targetId,
    lastSeq: p.lastSeq,
  };
}

/**
 * Leak tripwire used by tests and by the host in development: returns the secret words of players
 * that are still `alive` found anywhere in the public snapshot OUTSIDE of guessed-row words and
 * nicknames. (Those two are user input and are public by design — e.g. A may legitimately type B's
 * word as an own guess, scored against A's own secret.)
 */
export function findLeakedSecrets(priv: PrivateGameState, pub: PublicGameState): string[] {
  if (pub.phase === 'FINISHED') return [];
  if (pub.players.some((p) => 'secret' in p) || pub.revealedSecrets) return ['<secret field present>'];
  const scrubbed = {
    ...pub,
    players: pub.players.map((p) => ({ ...p, nickname: '', rows: p.rows.map((r) => ({ ...r, word: '' })) })),
    spectators: pub.spectators.map((s) => ({ ...s, nickname: '' })),
  };
  // Exact JSON string values only: event names such as "STEAL_MISS" must not trip on a secret "STEAL".
  const json = JSON.stringify(scrubbed);
  return priv.players
    .filter((p) => p.status === 'alive' && p.secret && json.includes(`"${p.secret}"`))
    .map((p) => p.secret);
}

// -------------------------------------------------------------------------------------------------
// v1.1 sessions
// -------------------------------------------------------------------------------------------------

/**
 * How long clients keep a just-finished duel's boards on screen before its result card appears
 * (the steal shatter / final flip, FR-4.6). Shared by the projection and the client so a finished
 * duel stays in snapshots for as long as anyone can still be looking at it.
 */
export const RESULT_HOLD_MS = 2_200;

function toPublicSessionPlayer(p: SessionPlayer): SessionPlayer {
  return {
    id: p.id,
    nickname: p.nickname,
    isHost: p.isHost,
    connected: p.connected,
    disconnectedAt: p.disconnectedAt,
    lastSeq: p.lastSeq,
    joinedAt: p.joinedAt,
    status: p.status,
    streak: p.streak,
    duelId: p.duelId,
    availableAt: p.availableAt,
    eliminatedAt: p.eliminatedAt,
    eliminationReason: p.eliminationReason,
    rank: p.rank,
  };
}

function toPublicDuel(d: PrivateDuel, s: PrivateSessionState): PublicDuel {
  const g = d.state;
  const pub: PublicDuel = {
    id: d.id,
    number: d.number,
    playerIds: [d.playerIds[0], d.playerIds[1]],
    phase: g.phase,
    phaseEndsAt: g.phaseEndsAt,
    overtimeUsed: g.overtimeUsed,
    result: g.result ? { ...g.result } : undefined,
    playStartedAt: g.playStartedAt,
    finishedAt: g.finishedAt,
    players: g.players.map((p) => {
      const pp = toPublicPlayer(p);
      const session = s.players.find((x) => x.id === p.id);
      if (session) {
        // Connection and the action ack live at session level (they span duels).
        pp.connected = session.connected;
        pp.disconnectedAt = session.disconnectedAt;
        pp.lastSeq = session.lastSeq;
        pp.streak = session.streak;
      }
      return pp;
    }),
  };
  if (g.phase === 'FINISHED') pub.revealedSecrets = Object.fromEntries(g.players.map((p) => [p.id, p.secret]));
  return pub;
}

/**
 * Which duels a snapshot carries: every running duel, the duel that ended the session, and any
 * duel that finished recently enough that its players may still be looking at its result card.
 * Older finished duels are dropped so the snapshot stays small with 16 players (§8 size budget).
 */
export function isDuelVisible(d: PrivateDuel, s: PrivateSessionState, hostNow: number): boolean {
  if (isActivePhase(d.state.phase)) return true;
  if (s.finalDuelId === d.id) return true;
  if (d.state.phase !== 'FINISHED') return false;
  return (d.state.finishedAt ?? 0) + s.settings.resultBeatMs + RESULT_HOLD_MS + 1_000 >= hostNow;
}

/** FIX 1 for sessions — the ONLY way session state leaves the referee. Whitelist projection. */
export function toPublicSession(s: PrivateSessionState, hostNow: number): PublicSessionState {
  return {
    roomCode: s.roomCode,
    version: s.version,
    hostId: s.hostId,
    hostNow,
    phase: s.phase,
    settings: { ...s.settings },
    players: s.players.map(toPublicSessionPlayer),
    spectators: s.spectators.map((x) => ({ ...x })),
    eliminationOrder: s.eliminationOrder.map((g) => [...g]),
    result: s.result ? structuredClone(s.result) : undefined,
    sessionNumber: s.sessionNumber,
    lastEvents: s.lastEvents.map((e) => structuredClone(e)),
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    finalDuelId: s.finalDuelId,
    duels: s.duels.filter((d) => isDuelVisible(d, s, hostNow)).map((d) => toPublicDuel(d, s)),
  };
}

/**
 * Session leak tripwire: the secret of any still-`alive` player in a duel that is not FINISHED
 * must not appear anywhere in the snapshot outside guessed-row words, nicknames and the revealed
 * secrets of finished duels.
 */
export function findLeakedSessionSecrets(priv: PrivateSessionState, pub: PublicSessionState): string[] {
  const problems: string[] = [];
  for (const d of pub.duels) {
    if (d.phase !== 'FINISHED' && d.revealedSecrets) problems.push('<revealedSecrets on an unfinished duel>');
    if (d.players.some((p) => 'secret' in p)) problems.push('<secret field present>');
  }
  if (problems.length) return problems;
  const scrubbed = {
    ...pub,
    players: pub.players.map((p) => ({ ...p, nickname: '' })),
    spectators: pub.spectators.map((x) => ({ ...x, nickname: '' })),
    result: pub.result
      ? { ...pub.result, standings: pub.result.standings.map((st) => ({ ...st, nickname: '' })) }
      : undefined,
    lastEvents: pub.lastEvents.map((e) =>
      e.type === 'SESSION_FINISHED'
        ? { ...e, result: { ...e.result, standings: e.result.standings.map((st) => ({ ...st, nickname: '' })) } }
        : e,
    ),
    duels: pub.duels.map((d) => ({
      ...d,
      revealedSecrets: undefined,
      players: d.players.map((p) => ({ ...p, nickname: '', rows: p.rows.map((r) => ({ ...r, word: '' })) })),
    })),
  };
  const json = JSON.stringify(scrubbed);
  return priv.duels
    .filter((d) => d.state.phase !== 'FINISHED')
    .flatMap((d) => d.state.players)
    .filter((p) => p.status === 'alive' && p.secret && json.includes(`"${p.secret}"`))
    .map((p) => p.secret);
}
