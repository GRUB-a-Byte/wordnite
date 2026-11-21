import { evaluateOutcome, rankPlayers, timeoutOutcome } from './outcome';
import { isOpponent, pairPlayers } from './pairing';
import { scoreGuess } from './score';
import { pickSecrets } from './secrets';
import { InvalidSettingsError, resolveSettings } from './settings';
import {
  clearDuelClock,
  isActivePhase,
  isBattleRoyale,
  isPlayPhase,
  isWaitingForSeat,
  newPlayer,
  nextMatchSize,
  playersStillHere,
  resetPlayerForMatch,
} from './state';
import type {
  ClientAction,
  EliminationReason,
  EngineAction,
  EngineContext,
  GameEvent,
  GameEventInput,
  GameResult,
  PresenceRole,
  PrivateGameState,
  PrivatePlayer,
  ReduceResult,
  RejectReason,
  Rejection,
  Row,
} from './types';

/**
 * The referee. Pure: (state, action, ctx) → new state + rejections + events.
 *
 *  - No I/O, no Date.now(), no Math.random() — time and randomness come from `ctx` (NFR-8).
 *  - Actions are applied one at a time, fully (including all win checks), in the order the host
 *    received them (SRS §5 ordering principle). The caller (HostRunner) guarantees FIFO.
 *  - FIX 6: before ANY action is applied, due deadlines (countdown end, match / overtime timeout,
 *    disconnect forfeits) are applied first, in chronological order. A guess that arrives after
 *    the clock hit zero therefore can never sneak in between two TICKs.
 *  - Invalid actions are rejected BEFORE any mutation, so they never consume rows.
 */
export function reduce(state: PrivateGameState, action: EngineAction, ctx: EngineContext): ReduceResult {
  const tx: Tx = {
    s: structuredClone(state),
    ctx,
    events: [],
    rejections: [],
    changed: false,
  };

  advanceClock(tx, ctx.now);

  switch (action.type) {
    case 'TICK':
      break;
    case 'PRESENCE_JOIN':
      handleJoin(tx, action.playerId, action.nickname, action.role);
      break;
    case 'PRESENCE_LEAVE':
      handleLeave(tx, action.playerId);
      break;
    case 'ABANDON':
      handleAbandon(tx);
      break;
    default:
      handleClientAction(tx, action);
  }

  if (!tx.changed) {
    return { state, rejections: tx.rejections, events: [], changed: false };
  }
  tx.s.version += 1;
  tx.s.lastEvents = tx.events;
  return { state: tx.s, rejections: tx.rejections, events: tx.events, changed: true };
}

// -----------------------------------------------------------------------------------------------
// Transaction helpers
// -----------------------------------------------------------------------------------------------

interface Tx {
  s: PrivateGameState;
  ctx: EngineContext;
  events: GameEvent[];
  rejections: Rejection[];
  changed: boolean;
}

function emit(tx: Tx, e: GameEventInput): void {
  tx.s.eventCounter += 1;
  tx.events.push({ ...e, id: tx.s.eventCounter } as GameEvent);
  tx.changed = true;
}

function reject(tx: Tx, action: ClientAction, reason: RejectReason): void {
  tx.rejections.push({ playerId: action.playerId, clientSeq: action.clientSeq, reason });
}

function findPlayer(tx: Tx, id: string): PrivatePlayer | undefined {
  return tx.s.players.find((p) => p.id === id);
}

function normalizeWord(word: unknown): string {
  return typeof word === 'string' ? word.trim().toUpperCase() : '';
}

function isWellFormed(word: string, length: number): boolean {
  return word.length === length && /^[A-Z]+$/.test(word);
}

function addRow(tx: Tx, owner: PrivatePlayer, row: Omit<Row, 'id' | 'at'>, now: number): Row {
  tx.s.rowCounter += 1;
  const full: Row = { ...row, id: `m${tx.s.matchNumber}-r${tx.s.rowCounter}`, at: now };
  owner.rows.push(full);
  tx.changed = true;
  return full;
}

/** Idempotent elimination — a player can never be eliminated twice (FIX 6). */
function eliminate(tx: Tx, p: PrivatePlayer, reason: EliminationReason, at: number, by?: string): void {
  if (p.status === 'eliminated') return;
  p.status = 'eliminated';
  p.eliminatedAt = at;
  p.eliminationReason = reason;
  if (by) p.eliminatedBy = by;
  clearDuelClock(p); // v1.1 FD-7: an eliminated player has no duel clock
  tx.changed = true;
  emit(tx, { type: 'ELIMINATED', playerId: p.id, reason });
}

/** Idempotent finish — a match can never be won twice (FIX 6). */
function finish(tx: Tx, result: GameResult, at: number): void {
  if (!isActivePhase(tx.s.phase)) return;
  tx.s.phase = 'FINISHED';
  tx.s.result = { ...result, standings: placings(tx.s.players) };
  tx.s.finishedAt = at;
  delete tx.s.phaseEndsAt;
  tx.changed = true;
  emit(tx, { type: 'FINISHED', result: tx.s.result });
}

/**
 * Final placings: `rankPlayers()` order, except that players eliminated at the same moment (both
 * players of a drawn duel, v1.1 FD-3) share a place — competition ranking (1, 2, 2, 4).
 */
function placings(players: readonly PrivatePlayer[]): { playerId: string; place: number }[] {
  const ranked = rankPlayers(players);
  return ranked.map((pl, i) => {
    let first = i;
    while (first > 0) {
      const prev = ranked[first - 1] as PrivatePlayer;
      if (pl.status !== 'eliminated' || prev.status !== 'eliminated' || prev.eliminatedAt !== pl.eliminatedAt) break;
      first--;
    }
    return { playerId: pl.id, place: first + 1 };
  });
}

const royale = (tx: Tx) => isBattleRoyale(tx.s.players.length);

/**
 * After any status change: players whose opponent is out are paired again, at random, with another
 * free player — pairs stay mutual (pairing.ts). Not run once the match is over (pairs freeze for
 * the end screen).
 *
 * v1.1 (battle royale): every NEW pair starts a fresh duel — new words, blank boards, its own
 * countdown and clock (FD-1, FD-7). A player left without an opponent waits (WR-1).
 */
function retarget(tx: Tx, at = tx.ctx.now): void {
  if (!isActivePhase(tx.s.phase)) return;
  const changed = pairPlayers(tx.s.players, tx.ctx.rng);
  const started = new Set<string>();
  for (const id of changed) {
    const pl = findPlayer(tx, id);
    if (!pl) continue;
    if (royale(tx)) {
      const opp = pl.targetId ? findPlayer(tx, pl.targetId) : undefined;
      if (opp && !started.has(pl.id)) {
        startFreshDuel(tx, pl, opp, at);
        started.add(pl.id).add(opp.id);
      } else if (!opp) {
        clearDuelClock(pl); // WR: waiting — no clock, no actions
      }
    }
    emit(tx, { type: 'TARGET_CHANGED', playerId: id, targetId: pl.targetId });
  }
}

/** Words nobody in the battle holds now, and that `players` never had this match (v1.1 FD-1). */
function freshSecrets(tx: Tx, players: readonly PrivatePlayer[]): string[] {
  const avoid = new Set<string>();
  for (const p of tx.s.players) if (p.status !== 'eliminated' && p.secret) avoid.add(p.secret);
  for (const p of players) for (const w of p.pastSecrets ?? []) avoid.add(w);
  const answers = tx.ctx.dictionary.answers;
  const pool = answers.filter((w) => !avoid.has(w));
  return pickSecrets(pool.length >= players.length ? pool : answers, players.length, tx.ctx.rng); // GR-2 holds either way
}

/**
 * v1.1 FD-1 / FD-7: a new pair starts a FRESH duel — both players get a new secret word and a fully
 * reset blank board (GR-3: alive, no rows, no shield, no steal shots), then the duel's own 3-2-1
 * countdown. Nothing carries over except being in the battle (and connection state, GR-35).
 */
function startFreshDuel(tx: Tx, a: PrivatePlayer, b: PrivatePlayer, at: number): void {
  const pair = [a, b];
  const words = freshSecrets(tx, pair);
  pair.forEach((p, i) => {
    const disconnectedAt = p.disconnectedAt;
    p.pastSecrets = [...(p.pastSecrets ?? []), p.secret].filter(Boolean);
    resetPlayerForMatch(p, tx.s.settings, words[i] as string);
    if (disconnectedAt !== undefined) p.disconnectedAt = disconnectedAt; // the GR-35 grace keeps running
  });
  startDuelClock(tx, a, b, at);
}

/** v1.1 FD-7: a duel's own countdown (GR-4), then its own clock and overtime. */
function startDuelClock(tx: Tx, a: PrivatePlayer, b: PrivatePlayer, at: number): void {
  for (const p of [a, b]) {
    p.duelPhase = 'COUNTDOWN';
    p.duelEndsAt = at + tx.s.settings.countdownMs;
    p.duelOvertimeUsed = false;
  }
  tx.changed = true;
}

/**
 * GR-25 … GR-29 after every gameplay mutation.
 *   1. Decisive statuses first (GR-26 last standing / GR-27 both solved / GR-29) — this is what
 *      makes a last-row successful steal a WIN rather than an out-of-rows loss (E-4).
 *   2. GR-25 row exhaustion.
 *   3. Re-evaluate, now including GR-28 (evaluated after GR-25 so an opponent who simply ran out
 *      of rows is reported as such, not as "unbeatable" — FIX 5).
 */
function resolveOutcome(tx: Tx, at: number): void {
  if (!isActivePhase(tx.s.phase)) return;
  if (royale(tx)) return resolveRoyale(tx, at);
  const first = evaluateOutcome(tx.s.players, tx.s.settings, { includeUnbeatable: false });
  if (first) {
    finish(tx, first, at);
    return;
  }
  for (const p of tx.s.players) {
    if (p.status === 'alive' && p.rowsUsed >= p.rowLimit) eliminate(tx, p, 'out_of_rows', at);
  }
  const second = evaluateOutcome(tx.s.players, tx.s.settings, { includeUnbeatable: true });
  if (second) finish(tx, second, at);
}

/** Each live duel once: [a, b] with a the earlier-joined player. */
function liveDuels(tx: Tx): [PrivatePlayer, PrivatePlayer][] {
  const out: [PrivatePlayer, PrivatePlayer][] = [];
  tx.s.players.forEach((a, i) => {
    if (a.status === 'eliminated' || !a.targetId) return;
    const j = tx.s.players.findIndex((p) => p.id === a.targetId);
    const b = tx.s.players[j];
    if (j > i && b && b.status !== 'eliminated' && b.targetId === a.id) out.push([a, b]);
  });
  return out;
}

/**
 * v1.1 battle royale outcome (FD-3, FD-4, match ending). Every DUEL is decided by the 1.0 duel
 * rules between its two players; the loser is out of the battle. The MATCH ends only when one
 * (or no) player is left — there is no match-level solve race, timeout or overtime any more.
 *   1. GR-27 per duel (both solved → fewer rows, then earlier).
 *   2. GR-25 for players still in a duel against a standing opponent. A duel winner who used their
 *      last row on the winning steal is NOT out of rows (E-4): their duel is already over.
 *   3. GR-28 per duel (evaluated after GR-25, as in 1.0 — FIX 5).
 *   4. Last one standing (GR-26) / nobody left (GR-29).
 */
function resolveRoyale(tx: Tx, at: number): void {
  const { settings } = tx.s;
  const outscore = (opts: { includeUnbeatable: boolean }, reasons: readonly string[]) => {
    for (const [a, b] of liveDuels(tx)) {
      const r = evaluateOutcome([a, b], settings, opts);
      if (r?.outcome !== 'win' || !reasons.includes(r.reason)) continue;
      const loser = r.winnerId === a.id ? b : a;
      eliminate(tx, loser, 'outscored', at);
    }
  };
  outscore({ includeUnbeatable: false }, ['fewer_rows', 'same_rows_earlier']);
  for (const [a, b] of liveDuels(tx)) {
    for (const p of [a, b]) if (p.status === 'alive' && p.rowsUsed >= p.rowLimit) eliminate(tx, p, 'out_of_rows', at);
  }
  outscore({ includeUnbeatable: true }, ['unbeatable']);

  const standing = tx.s.players.filter((p) => p.status !== 'eliminated');
  if (standing.length > 1) return;
  const result = evaluateOutcome(tx.s.players, settings, { includeUnbeatable: false });
  if (result) finish(tx, result, at);
}

/**
 * v1.1 FD-7: one duel's clock ran out (countdown → play, 2:00 → result or overtime, overtime →
 * result). GR-30 / GR-31 / GR-33 / GR-34 applied to the two duelists only.
 */
function duelDeadline(tx: Tx, a: PrivatePlayer, b: PrivatePlayer, at: number): void {
  const s = tx.s;
  tx.changed = true;
  if (a.duelPhase === 'COUNTDOWN') {
    for (const p of [a, b]) {
      p.duelPhase = 'PLAYING';
      p.duelEndsAt = at + s.settings.matchMs;
    }
    emit(tx, { type: 'PLAY_STARTED', playerIds: [a.id, b.id] });
    return;
  }
  const outcome = timeoutOutcome([a, b], a.duelPhase === 'PLAYING' && !a.duelOvertimeUsed);
  if (outcome.kind === 'overtime') {
    for (const p of [a, b]) {
      p.duelPhase = 'OVERTIME';
      p.duelOvertimeUsed = true;
      p.duelEndsAt = at + s.settings.overtimeMs;
      if (p.status === 'alive') p.rowLimit += s.settings.overtimeExtraRows;
    }
    emit(tx, { type: 'OVERTIME_START', extraRows: s.settings.overtimeExtraRows, playerIds: [a.id, b.id] });
    return;
  }
  const r = outcome.result;
  if (r.outcome === 'win') {
    eliminate(tx, r.winnerId === a.id ? b : a, 'outscored', at); // GR-30: the only solver wins the duel
  } else {
    eliminate(tx, a, 'duel_draw', at); // GR-33: nobody solved in overtime — both are out
    eliminate(tx, b, 'duel_draw', at);
  }
  resolveOutcome(tx, at);
  retarget(tx, at);
}

// -----------------------------------------------------------------------------------------------
// Clock: countdown end, match timeout, overtime timeout, disconnect forfeits (chronological)
// -----------------------------------------------------------------------------------------------

type Due =
  | { at: number; kind: 'phase' }
  | { at: number; kind: 'forfeit'; playerId: string }
  | { at: number; kind: 'duel'; playerId: string };

function nextDue(s: PrivateGameState, now: number): Due | null {
  if (!isActivePhase(s.phase)) return null;
  let best: Due | null = null;
  if (s.phaseEndsAt !== undefined && s.phaseEndsAt <= now) best = { at: s.phaseEndsAt, kind: 'phase' };
  for (const p of s.players) {
    if (p.connected || p.disconnectedAt === undefined || p.status === 'eliminated' || p.id === s.hostId) continue;
    const at = p.disconnectedAt + s.settings.guestGraceMs;
    if (at <= now && (!best || at < best.at)) best = { at, kind: 'forfeit', playerId: p.id };
  }
  // v1.1 FD-7: every battle-royale duel's own deadline (read off the earlier-joined player).
  s.players.forEach((p, i) => {
    if (p.status === 'eliminated' || !p.targetId || p.duelEndsAt === undefined) return;
    if (s.players.findIndex((o) => o.id === p.targetId) < i) return;
    const at = p.duelEndsAt;
    if (at <= now && (!best || at < best.at)) best = { at, kind: 'duel', playerId: p.id };
  });
  return best;
}

function advanceClock(tx: Tx, now: number): void {
  // Up to 100 players can mean ~50 duel deadlines falling due in one call.
  for (let guard = 0; guard < 256; guard++) {
    const due = nextDue(tx.s, now);
    if (!due) return;
    if (due.kind === 'forfeit') {
      const p = findPlayer(tx, due.playerId);
      if (p) {
        eliminate(tx, p, 'forfeit', due.at); // GR-35 (applies to every status, SRS §4.2)
        resolveOutcome(tx, due.at);
        retarget(tx, due.at);
      }
      continue;
    }
    if (due.kind === 'duel') {
      const a = findPlayer(tx, due.playerId);
      const b = a?.targetId ? findPlayer(tx, a.targetId) : undefined;
      if (a && b) duelDeadline(tx, a, b, due.at);
      else if (a) clearDuelClock(a);
      continue;
    }
    phaseDeadline(tx, due.at);
  }
}

function phaseDeadline(tx: Tx, at: number): void {
  const s = tx.s;
  if (s.phase === 'COUNTDOWN') {
    // GR-4 / GR-5: play starts exactly at the countdown deadline.
    s.phase = 'PLAYING';
    s.playStartedAt = at;
    s.phaseEndsAt = at + s.settings.matchMs;
    tx.changed = true;
    emit(tx, { type: 'PLAY_STARTED' });
    return;
  }
  // GR-30 (match timeout) / GR-33 (overtime timeout).
  const outcome = timeoutOutcome(s.players, s.phase === 'PLAYING' && !s.overtimeUsed);
  if (outcome.kind === 'result') {
    finish(tx, outcome.result, at);
    return;
  }
  // GR-31: overtime — +N rows for every alive player, new deadline, at most once (GR-34).
  s.phase = 'OVERTIME';
  s.overtimeUsed = true;
  s.phaseEndsAt = at + s.settings.overtimeMs;
  for (const p of s.players) if (p.status === 'alive') p.rowLimit += s.settings.overtimeExtraRows;
  tx.changed = true;
  emit(tx, { type: 'OVERTIME_START', extraRows: s.settings.overtimeExtraRows });
}

// -----------------------------------------------------------------------------------------------
// Presence (lobby roster, disconnects — GR-35)
// -----------------------------------------------------------------------------------------------

function handleJoin(tx: Tx, playerId: string, rawNickname: string, role: PresenceRole): void {
  const s = tx.s;
  const nickname = rawNickname.slice(0, 16) || 'Player';
  const player = findPlayer(tx, playerId);
  if (player) {
    if (!player.connected || player.disconnectedAt !== undefined) {
      player.connected = true;
      delete player.disconnectedAt;
      tx.changed = true;
    }
    if (s.phase === 'LOBBY' && player.nickname !== nickname) {
      player.nickname = nickname;
      tx.changed = true;
    }
    return;
  }
  const spectator = s.spectators.find((sp) => sp.id === playerId);
  if (spectator) {
    if (!spectator.connected || spectator.nickname !== nickname) {
      spectator.connected = true;
      spectator.nickname = nickname;
      tx.changed = true;
    }
    if (s.phase === 'LOBBY') promoteSpectators(tx);
    return;
  }
  const wantsToPlay = role !== 'spectator';
  if (s.phase === 'LOBBY' && wantsToPlay && s.players.length < s.settings.maxPlayers) {
    s.players.push(newPlayer(playerId, nickname, false, s.settings));
  } else {
    // E-16: room full / match running → spectator. GR-1: never more than maxPlayers players.
    s.spectators.push({ id: playerId, nickname, connected: true, wantsToPlay, joinedAt: tx.ctx.now });
  }
  tx.changed = true;
}

function handleLeave(tx: Tx, playerId: string): void {
  const s = tx.s;
  if (playerId === s.hostId) return; // the host's own engine never sees itself leave (GR-36 is client-side)
  const idx = s.players.findIndex((p) => p.id === playerId);
  if (idx >= 0) {
    const p = s.players[idx] as PrivatePlayer;
    if (s.phase === 'LOBBY') {
      s.players.splice(idx, 1);
      tx.changed = true;
      promoteSpectators(tx);
    } else if (p.connected) {
      p.connected = false;
      p.disconnectedAt = tx.ctx.now; // GR-35 grace starts now (only enforced in active phases)
      tx.changed = true;
    }
    return;
  }
  const sIdx = s.spectators.findIndex((sp) => sp.id === playerId);
  if (sIdx >= 0) {
    s.spectators.splice(sIdx, 1);
    tx.changed = true;
  }
}

/** Fills free player seats in the lobby with connected spectators who wanted to play (join order). */
/** Connected spectators who want to play, first come first served (projector "?watch=1" viewers never do). */
function waitingSpectators(s: PrivateGameState) {
  return s.spectators.filter(isWaitingForSeat).sort((a, b) => a.joinedAt - b.joinedAt);
}

/**
 * Moves waiting spectators into free player seats (up to maxPlayers). Runs in the lobby, and when
 * the host starts the next match from the end screen — people who arrived mid-match watch that
 * match and play the next one.
 */
function promoteSpectators(tx: Tx, betweenMatches = false): void {
  const s = tx.s;
  if (s.phase !== 'LOBBY' && !betweenMatches) return;
  const queue = waitingSpectators(s);
  for (const sp of queue) {
    if (s.players.length >= s.settings.maxPlayers) break;
    s.players.push(newPlayer(sp.id, sp.nickname, false, s.settings));
    s.spectators = s.spectators.filter((x) => x.id !== sp.id);
    tx.changed = true;
  }
}

function handleAbandon(tx: Tx): void {
  const s = tx.s;
  if (!isActivePhase(s.phase)) return;
  s.phase = 'ABANDONED';
  s.result = { outcome: 'abandoned', reason: 'abandoned' };
  s.finishedAt = tx.ctx.now;
  delete s.phaseEndsAt;
  tx.changed = true;
  emit(tx, { type: 'FINISHED', result: s.result });
}

// -----------------------------------------------------------------------------------------------
// Client actions
// -----------------------------------------------------------------------------------------------

function handleClientAction(tx: Tx, action: ClientAction): void {
  const actor = findPlayer(tx, action.playerId);
  if (!actor) {
    reject(tx, action, 'not_a_player');
    return;
  }
  // FIX 6: every action carries a per-player increasing sequence number. Re-deliveries and
  // replays are rejected without side effects.
  if (!Number.isInteger(action.clientSeq) || action.clientSeq <= actor.lastSeq) {
    reject(tx, action, 'duplicate_seq');
    return;
  }
  actor.lastSeq = action.clientSeq; // the state broadcast doubles as the ack for this action
  tx.changed = true;

  switch (action.type) {
    case 'GUESS':
      return handleGuess(tx, action, actor);
    case 'STEAL':
      return handleSteal(tx, action, actor);
    case 'START':
      return handleStart(tx, action, actor);
    case 'REMATCH':
      return handleRematch(tx, action, actor);
    case 'RETURN_TO_LOBBY':
      return handleReturnToLobby(tx, action, actor);
    case 'UPDATE_SETTINGS':
      return handleUpdateSettings(tx, action, actor);
  }
}

/**
 * v1.1 battle royale: WR-1 — no opponent, no action at all; FD-7 — nothing is accepted during a
 * duel's own countdown.
 */
function duelBlock(p: PrivatePlayer): RejectReason | null {
  if (!p.targetId) return 'waiting_for_opponent';
  if (p.duelPhase !== 'PLAYING' && p.duelPhase !== 'OVERTIME') return 'not_playing';
  return null;
}

function handleGuess(tx: Tx, action: Extract<ClientAction, { type: 'GUESS' }>, p: PrivatePlayer): void {
  const { s, ctx } = tx;
  if (!isPlayPhase(s.phase)) return reject(tx, action, 'not_playing'); // GR-14
  if (p.status === 'eliminated') return reject(tx, action, 'eliminated'); // GR-14
  if (royale(tx)) {
    const blocked = duelBlock(p);
    if (blocked) return reject(tx, action, blocked);
  }
  if (p.status === 'invulnerable') return reject(tx, action, 'already_solved'); // GR-19
  const word = normalizeWord(action.word);
  if (!isWellFormed(word, s.settings.wordLength) || !ctx.dictionary.isValid(word)) {
    return reject(tx, action, 'invalid_word'); // GR-11, GR-12
  }
  if (p.rows.some((r) => r.targetId === p.id && r.word === word)) return reject(tx, action, 'duplicate'); // GR-13
  if (p.rowsUsed >= p.rowLimit) return reject(tx, action, 'no_rows'); // GR-15 (defensive)

  const hit = word === p.secret;
  const row = addRow(
    tx,
    p,
    { word, tiles: scoreGuess(word, p.secret), kind: 'own', targetId: p.id, scoring: true, hit },
    ctx.now,
  );
  p.rowsUsed += 1; // GR-17
  emit(tx, { type: 'ROW_ADDED', playerId: p.id, rowId: row.id });

  if (hit) {
    // GR-18: solve → invulnerable, row count + time locked, post-solve steal rows granted.
    p.status = 'invulnerable';
    p.solvedInRows = p.rowsUsed;
    p.solvedAt = ctx.now;
    p.solveOrder = s.rowCounter;
    p.postSolveStealRows = s.settings.postSolveStealRows;
    emit(tx, { type: 'SOLVED', playerId: p.id, rows: p.rowsUsed });
  }
  resolveOutcome(tx, ctx.now);
  retarget(tx);
}

function handleSteal(tx: Tx, action: Extract<ClientAction, { type: 'STEAL' }>, p: PrivatePlayer): void {
  const { s, ctx } = tx;
  if (!isPlayPhase(s.phase)) return reject(tx, action, 'not_playing'); // GR-14
  if (p.status === 'eliminated') return reject(tx, action, 'eliminated'); // GR-14
  if (royale(tx)) {
    const blocked = duelBlock(p);
    if (blocked) return reject(tx, action, blocked);
  }
  const target = findPlayer(tx, action.targetId);
  if (!target || target.id === p.id) return reject(tx, action, 'invalid_target');
  if (target.status === 'invulnerable') return reject(tx, action, 'target_shielded'); // GR-20, E-2
  if (target.status === 'eliminated') return reject(tx, action, 'target_eliminated'); // GR-20
  if (!isOpponent(s.players, p.id, target.id)) return reject(tx, action, 'invalid_target'); // you only fight your own opponent
  const word = normalizeWord(action.word);
  if (!isWellFormed(word, s.settings.wordLength) || !ctx.dictionary.isValid(word)) {
    return reject(tx, action, 'invalid_word');
  }
  if (p.rows.some((r) => r.targetId === target.id && r.word === word)) return reject(tx, action, 'duplicate');

  // GR-21: who pays for the steal.
  const scoring = p.status === 'alive';
  if (scoring && p.rowsUsed >= p.rowLimit) return reject(tx, action, 'no_rows');
  if (!scoring && p.postSolveStealRows <= 0) return reject(tx, action, 'no_ammo'); // E-6

  const hit = word === target.secret; // GR-24: compared with the TARGET's word only
  const row = addRow(
    tx,
    p,
    { word, tiles: scoreGuess(word, target.secret), kind: 'steal', targetId: target.id, scoring, hit },
    ctx.now,
  );
  if (scoring) p.rowsUsed += 1;
  else p.postSolveStealRows -= 1;
  emit(tx, { type: 'ROW_ADDED', playerId: p.id, rowId: row.id });

  if (hit) {
    emit(tx, { type: 'STEAL_HIT', stealerId: p.id, targetId: target.id, rowId: row.id });
    eliminate(tx, target, 'stolen', ctx.now, p.id); // GR-23
  } else {
    emit(tx, { type: 'STEAL_MISS', stealerId: p.id, targetId: target.id, rowId: row.id });
  }
  resolveOutcome(tx, ctx.now);
  retarget(tx);
}

function canStartMatch(s: PrivateGameState): boolean {
  const n = s.players.length;
  return n >= 2 && n <= s.settings.maxPlayers && s.players.every((p) => p.connected);
}

function startMatch(tx: Tx): void {
  const { s, ctx } = tx;
  const secrets = pickSecrets(ctx.dictionary.answers, s.players.length, ctx.rng); // GR-2
  s.matchNumber += 1;
  s.rowCounter = 0;
  s.players.forEach((p, i) => {
    resetPlayerForMatch(p, s.settings, secrets[i] as string); // GR-3
    clearDuelClock(p);
    delete p.pastSecrets;
  });
  pairPlayers(s.players, ctx.rng, true); // random symmetric pairs: A↔B, C↔D, … (odd one out waits)
  s.overtimeUsed = false;
  delete s.result;
  delete s.playStartedAt;
  delete s.finishedAt;
  if (royale(tx)) {
    // v1.1 FD-7: no match clock. The match is simply on; every duel runs its own countdown + clock.
    s.phase = 'PLAYING';
    s.playStartedAt = ctx.now;
    delete s.phaseEndsAt;
    for (const p of s.players) {
      const opp = p.targetId ? findPlayer(tx, p.targetId) : undefined;
      if (opp && p.duelPhase === undefined) startDuelClock(tx, p, opp, ctx.now);
    }
  } else {
    s.phase = 'COUNTDOWN'; // GR-4
    s.phaseEndsAt = ctx.now + s.settings.countdownMs;
  }
  tx.changed = true;
  emit(tx, { type: 'MATCH_STARTED', matchNumber: s.matchNumber });
  advanceClock(tx, ctx.now); // handles countdownMs === 0
}

function handleStart(tx: Tx, action: Extract<ClientAction, { type: 'START' }>, p: PrivatePlayer): void {
  if (p.id !== tx.s.hostId) return reject(tx, action, 'not_host');
  if (tx.s.phase !== 'LOBBY') return reject(tx, action, 'not_playing');
  if (!canStartMatch(tx.s)) return reject(tx, action, 'not_enough_players'); // FR-2.2
  startMatch(tx);
}

function handleRematch(tx: Tx, action: Extract<ClientAction, { type: 'REMATCH' }>, p: PrivatePlayer): void {
  if (p.id !== tx.s.hostId) return reject(tx, action, 'not_host');
  if (tx.s.phase !== 'FINISHED') return reject(tx, action, 'not_playing');
  // Players who left the room do not block a rematch, and spectators waiting to play take free
  // seats (up to the cap). Only a lone player is refused — a match needs at least two.
  if (nextMatchSize(tx.s) < 2) return reject(tx, action, 'not_enough_players');
  tx.s.players = playersStillHere(tx.s.players, tx.s.hostId);
  promoteSpectators(tx, true);
  if (!canStartMatch(tx.s)) return reject(tx, action, 'not_enough_players');
  startMatch(tx); // GR-37: new secrets, state reset, back to countdown
}

function handleReturnToLobby(
  tx: Tx,
  action: Extract<ClientAction, { type: 'RETURN_TO_LOBBY' }>,
  p: PrivatePlayer,
): void {
  const s = tx.s;
  if (p.id !== s.hostId) return reject(tx, action, 'not_host');
  if (s.phase !== 'FINISHED' && s.phase !== 'ABANDONED') return reject(tx, action, 'not_playing');
  s.phase = 'LOBBY';
  delete s.result;
  delete s.phaseEndsAt;
  delete s.playStartedAt;
  delete s.finishedAt;
  s.overtimeUsed = false;
  s.players = playersStillHere(s.players, s.hostId);
  for (const pl of s.players) {
    resetPlayerForMatch(pl, s.settings, '');
    delete pl.targetId;
    delete pl.pastSecrets;
    clearDuelClock(pl);
  }
  tx.changed = true;
  promoteSpectators(tx);
}

function handleUpdateSettings(
  tx: Tx,
  action: Extract<ClientAction, { type: 'UPDATE_SETTINGS' }>,
  p: PrivatePlayer,
): void {
  const s = tx.s;
  if (p.id !== s.hostId) return reject(tx, action, 'not_host');
  if (s.phase !== 'LOBBY') return reject(tx, action, 'not_playing');
  try {
    s.settings = resolveSettings(action.patch ?? {}, s.settings);
  } catch (err) {
    if (err instanceof InvalidSettingsError) return reject(tx, action, 'invalid_settings');
    throw err;
  }
  for (const pl of s.players) pl.rowLimit = s.settings.baseRows;
  // Lowered cap: the most recent non-host joiners wait as spectators (first in line if it rises again).
  while (s.players.length > s.settings.maxPlayers) {
    const idx = s.players.map((pl) => pl.id !== s.hostId).lastIndexOf(true);
    const [moved] = s.players.splice(idx, 1);
    if (moved) s.spectators.unshift({ id: moved.id, nickname: moved.nickname, connected: moved.connected, wantsToPlay: true, joinedAt: 0 });
  }
  tx.changed = true;
  promoteSpectators(tx); // raised cap: waiting spectators join
}
