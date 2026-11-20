import type { PrivateGameState, PrivatePlayer, PublicGameState, PublicPlayer, Row } from './types';

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
