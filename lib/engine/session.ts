import { pairAvailable, shuffleAndPair } from './pairing';
import { beginMatch, nextDeadline, reduce } from './reducer';
import { DEFAULT_SETTINGS, InvalidSettingsError, resolveSettings, validateSettings } from './settings';
import { isActivePhase, newPlayer } from './state';
import type {
  ClientAction,
  EngineAction,
  EngineContext,
  GameEvent,
  GameSettings,
  PresenceRole,
  PrivateDuel,
  PrivateGameState,
  PrivateSessionState,
  RejectReason,
  Rejection,
  RoomEvent,
  SessionEliminationReason,
  SessionPlayer,
  SessionReduceResult,
  SessionResult,
  WordDictionary,
} from './types';

/**
 * v1.1 King of the hill — the session referee (docs/SRS_AMENDMENT_v1.1.md §3).
 *
 * Sits ABOVE the 1.0 duel reducer: every duel is a full 2-player `PrivateGameState` driven by the
 * unchanged `reduce()` (KH-5). This module only decides who duels whom (KH-2/3/9/10), what a duel
 * result means for the session (KH-7/8), and when the session ends (KH-10c).
 *
 * Pure like the duel reducer: no I/O, no Date.now(), no Math.random() (NFR-8, NFR-13).
 *
 * Ordering (SRS §5, FIX 6 — applied across all duels): before any action, every due deadline of
 * every duel (countdown / timeout / forfeit), every result-beat expiry and every waiting-room
 * forfeit is applied in chronological order. Actions are then applied one at a time.
 */

type RoomEventInput = RoomEvent extends infer E ? (E extends RoomEvent ? Omit<E, 'id'> : never) : never;

interface STx {
  s: PrivateSessionState;
  ctx: EngineContext;
  events: RoomEvent[];
  rejections: Rejection[];
  changed: boolean;
}

export interface CreateSessionInput {
  roomCode: string;
  hostId: string;
  hostNickname: string;
  settings?: GameSettings;
  now?: number;
}

function newSessionPlayer(id: string, nickname: string, isHost: boolean, joinedAt: number): SessionPlayer {
  return { id, nickname, isHost, connected: true, lastSeq: 0, joinedAt, status: 'waiting', streak: 0 };
}

export function createSessionLobby(input: CreateSessionInput): PrivateSessionState {
  const settings = validateSettings({ ...(input.settings ?? DEFAULT_SETTINGS) });
  return {
    roomCode: input.roomCode,
    version: 1,
    hostId: input.hostId,
    phase: 'LOBBY',
    settings,
    players: [newSessionPlayer(input.hostId, input.hostNickname, true, input.now ?? 0)],
    spectators: [],
    eliminationOrder: [],
    sessionNumber: 0,
    lastEvents: [],
    duels: [],
    duelCounter: 0,
    eventCounter: 0,
  };
}

export function reduceSession(
  state: PrivateSessionState,
  action: EngineAction,
  ctx: EngineContext,
): SessionReduceResult {
  const tx: STx = { s: structuredClone(state), ctx, events: [], rejections: [], changed: false };

  advance(tx, ctx.now);

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

  // A zero result beat (or a forfeit applied by the action) may make players available right now.
  advance(tx, ctx.now);

  if (!tx.changed) return { state, rejections: tx.rejections, events: [], changed: false };
  tx.s.version += 1;
  tx.s.lastEvents = tx.events;
  return { state: tx.s, rejections: tx.rejections, events: tx.events, changed: true };
}

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

function emit(tx: STx, e: RoomEventInput): void {
  tx.s.eventCounter += 1;
  tx.events.push({ ...e, id: tx.s.eventCounter } as RoomEvent);
  tx.changed = true;
}

/** Re-numbers a duel event into the session's event stream, tagged with its duel. */
function emitDuelEvent(tx: STx, e: GameEvent, duelId: string): void {
  const copy: Partial<GameEvent> & { duelId: string } = { ...e, duelId };
  delete copy.id;
  emit(tx, copy as RoomEventInput);
}

function reject(tx: STx, action: ClientAction, reason: RejectReason): void {
  tx.rejections.push({ playerId: action.playerId, clientSeq: action.clientSeq, reason });
}

function sp(tx: STx, id: string): SessionPlayer | undefined {
  return tx.s.players.find((p) => p.id === id);
}

function duelOf(tx: STx, id: string | undefined): PrivateDuel | undefined {
  return id === undefined ? undefined : tx.s.duels.find((d) => d.id === id);
}

function activeDuels(s: PrivateSessionState): PrivateDuel[] {
  return s.duels.filter((d) => isActivePhase(d.state.phase));
}

/**
 * GR-2 within a duel always; across the session SHOULD (KH-5): secrets already used by any duel
 * this session are excluded while enough answers remain.
 */
function secretDictionary(tx: STx): WordDictionary {
  const used = new Set(tx.s.duels.flatMap((d) => d.state.players.map((p) => p.secret)));
  const fresh = tx.ctx.dictionary.answers.filter((w) => !used.has(w));
  return { isValid: tx.ctx.dictionary.isValid, answers: fresh.length >= 2 ? fresh : tx.ctx.dictionary.answers };
}

// -----------------------------------------------------------------------------------------------
// Clock: all duels' deadlines, result beats, waiting-room forfeits — strictly chronological
// -----------------------------------------------------------------------------------------------

type Due =
  | { at: number; kind: 'duel'; duelId: string }
  | { at: number; kind: 'forfeit'; playerId: string }
  | { at: number; kind: 'beat' };

const DUE_PRIORITY: Record<Due['kind'], number> = { duel: 0, forfeit: 1, beat: 2 };

function nextSessionDue(s: PrivateSessionState, now: number): Due | null {
  if (s.phase !== 'IN_PROGRESS') return null;
  const candidates: Due[] = [];
  for (const d of activeDuels(s)) {
    const at = nextDeadline(d.state);
    if (at !== undefined && at <= now) candidates.push({ at, kind: 'duel', duelId: d.id });
  }
  for (const p of s.players) {
    if (p.status === 'hill_holder' && p.availableAt !== undefined && p.availableAt <= now) {
      candidates.push({ at: p.availableAt, kind: 'beat' });
    }
    // KH-11: a waiting player who stays disconnected past the grace period is eliminated.
    if (p.status === 'waiting' && !p.connected && p.disconnectedAt !== undefined && p.id !== s.hostId) {
      const at = p.disconnectedAt + s.settings.guestGraceMs;
      if (at <= now) candidates.push({ at, kind: 'forfeit', playerId: p.id });
    }
  }
  candidates.sort((a, b) => a.at - b.at || DUE_PRIORITY[a.kind] - DUE_PRIORITY[b.kind]);
  return candidates[0] ?? null;
}

function advance(tx: STx, now: number): void {
  for (let guard = 0; guard < 512; guard++) {
    const due = nextSessionDue(tx.s, now);
    if (!due) return;
    if (due.kind === 'duel') {
      const duel = duelOf(tx, due.duelId);
      if (duel) runDuel(tx, duel, { type: 'TICK' }, due.at);
    } else if (due.kind === 'forfeit') {
      const p = sp(tx, due.playerId);
      if (p) {
        eliminateFromSession(tx, [p], 'forfeit', due.at);
        checkSessionEnd(tx, due.at);
      }
    } else {
      repair(tx, due.at);
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Duels
// -----------------------------------------------------------------------------------------------

/** Runs one action through a duel's (unchanged) reducer and folds its effects into the session. */
function runDuel(tx: STx, duel: PrivateDuel, action: EngineAction, at: number) {
  const wasActive = isActivePhase(duel.state.phase);
  const res = reduce(duel.state, action, { ...tx.ctx, now: at });
  for (const r of res.rejections) tx.rejections.push(r);
  if (!res.changed) return res;
  duel.state = res.state;
  tx.changed = true;
  for (const e of res.events) emitDuelEvent(tx, e, duel.id);
  if (wasActive && !isActivePhase(duel.state.phase)) onDuelFinished(tx, duel, at);
  return res;
}

function createDuel(tx: STx, ids: [string, string], at: number): void {
  const s = tx.s;
  // Seat order inside a duel (left/right on the projector; 2 players → host first, as in 1.0).
  const seat = (id: string) => s.players.findIndex((p) => p.id === id);
  const pair = [...ids].sort((a, b) => seat(a) - seat(b)) as [string, string];
  const [a, b] = pair.map((id) => sp(tx, id) as SessionPlayer) as [SessionPlayer, SessionPlayer];
  s.duelCounter += 1;
  const number = s.duelCounter;
  const id = `d${number}`;
  const settings = { ...s.settings };
  const base: PrivateGameState = {
    roomCode: s.roomCode,
    version: 0,
    hostId: s.hostId,
    phase: 'LOBBY',
    overtimeUsed: false,
    settings,
    players: [newPlayer(a.id, a.nickname, a.isHost, settings), newPlayer(b.id, b.nickname, b.isHost, settings)],
    spectators: [],
    lastEvents: [],
    matchNumber: number - 1, // startMatch increments → duel number (unique row ids / draft keys)
    rowCounter: 0,
    eventCounter: 0,
  };
  emit(tx, { type: 'PAIRED', duelId: id, playerIds: pair });
  const res = beginMatch(base, { ...tx.ctx, now: at, dictionary: secretDictionary(tx) });
  const duel: PrivateDuel = { id, number, playerIds: pair, state: res.state };
  // KH-11 / E-33: a player paired while disconnected keeps their grace clock running in the duel.
  for (const p of duel.state.players) {
    const session = sp(tx, p.id);
    if (session && !session.connected) {
      p.connected = false;
      p.disconnectedAt = session.disconnectedAt ?? at;
    }
  }
  s.duels.push(duel);
  for (const e of res.events) emitDuelEvent(tx, e, id);
  for (const p of [a, b]) {
    p.status = 'dueling';
    p.duelId = id;
    delete p.availableAt;
  }
  tx.changed = true;
}

/** KH-7 / KH-8 then KH-10c. */
function onDuelFinished(tx: STx, duel: PrivateDuel, at: number): void {
  const result = duel.state.result;
  if (!result || result.outcome === 'abandoned') return;
  emit(tx, { type: 'DUEL_FINISHED', duelId: duel.id, result: { ...result } });
  const [a, b] = duel.playerIds.map((id) => sp(tx, id)) as [SessionPlayer | undefined, SessionPlayer | undefined];
  if (result.outcome === 'win' && result.winnerId) {
    const winner = sp(tx, result.winnerId);
    const loser = [a, b].find((p) => p && p.id !== result.winnerId);
    if (winner) {
      winner.streak += 1;
      winner.status = 'hill_holder';
      winner.availableAt = at + tx.s.settings.resultBeatMs;
    }
    if (loser) eliminateFromSession(tx, [loser], 'lost', at, duel.id);
  } else {
    eliminateFromSession(tx, [a, b].filter((p): p is SessionPlayer => !!p), 'draw', at, duel.id); // D-19
  }
  checkSessionEnd(tx, at, duel.id);
}

function eliminateFromSession(
  tx: STx,
  players: SessionPlayer[],
  reason: SessionEliminationReason,
  at: number,
  duelId?: string,
): void {
  const group = players.filter((p) => p.status !== 'eliminated' && p.status !== 'champion');
  if (!group.length) return;
  for (const p of group) {
    p.status = 'eliminated';
    p.eliminatedAt = at;
    p.eliminationReason = reason;
    delete p.availableAt;
  }
  // Competition ranking: everyone eliminated together shares the best rank still open.
  const rank = tx.s.players.filter((p) => p.status !== 'eliminated').length + 1;
  for (const p of group) p.rank = rank;
  tx.s.eliminationOrder.push(group.map((p) => p.id));
  for (const p of group) emit(tx, { type: 'SESSION_ELIMINATED', playerId: p.id, duelId, reason });
  tx.changed = true;
}

/** KH-10c: one survivor → champion; none → draw. Only when no duel is still running. */
function checkSessionEnd(tx: STx, at: number, duelId?: string): void {
  const s = tx.s;
  if (s.phase !== 'IN_PROGRESS' || activeDuels(s).length > 0) return;
  const remaining = s.players.filter((p) => p.status !== 'eliminated');
  if (remaining.length > 1) return;
  const champion = remaining[0];
  if (champion) {
    champion.status = 'champion';
    champion.rank = 1;
    delete champion.availableAt;
  }
  s.phase = 'FINISHED';
  s.finishedAt = at;
  s.finalDuelId = duelId ?? [...s.duels].reverse().find((d) => d.state.phase === 'FINISHED')?.id;
  const result: SessionResult = {
    outcome: champion ? 'champion' : 'draw',
    championId: champion?.id,
    standings: standings(s),
  };
  s.result = result;
  tx.changed = true;
  emit(tx, { type: 'SESSION_FINISHED', result: structuredClone(result) });
}

function standings(s: PrivateSessionState): SessionResult['standings'] {
  return s.players
    .filter((p) => p.rank !== undefined)
    .map((p) => ({ playerId: p.id, nickname: p.nickname, rank: p.rank as number, streak: p.streak }))
    .sort((a, b) => a.rank - b.rank || b.streak - a.streak || a.nickname.localeCompare(b.nickname));
}

/** KH-9 / KH-10a: pair the waiting player and every hill-holder whose beat has ended. */
function repair(tx: STx, at: number): void {
  const s = tx.s;
  if (s.phase !== 'IN_PROGRESS') return;
  const waiting = s.players.filter((p) => p.status === 'waiting');
  const ready = s.players
    .filter((p) => p.status === 'hill_holder' && p.availableAt !== undefined && p.availableAt <= at)
    .sort((a, b) => (a.availableAt as number) - (b.availableAt as number));
  const { pairs, waiting: leftOver } = pairAvailable([...waiting, ...ready].map((p) => p.id));
  for (const pair of pairs) createDuel(tx, pair, at);
  if (leftOver) {
    const p = sp(tx, leftOver) as SessionPlayer;
    if (p.status !== 'waiting') {
      p.status = 'waiting';
      delete p.availableAt;
      tx.changed = true;
      emit(tx, { type: 'WAITING', playerId: p.id });
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Presence
// -----------------------------------------------------------------------------------------------

function liveDuelOf(tx: STx, p: SessionPlayer): PrivateDuel | undefined {
  const d = duelOf(tx, p.duelId);
  return d && isActivePhase(d.state.phase) ? d : undefined;
}

function handleJoin(tx: STx, playerId: string, rawNickname: string, role: PresenceRole): void {
  const s = tx.s;
  const nickname = rawNickname.slice(0, 16) || 'Player';
  const player = sp(tx, playerId);
  if (player) {
    if (!player.connected || player.disconnectedAt !== undefined) {
      player.connected = true;
      delete player.disconnectedAt;
      tx.changed = true;
      const duel = liveDuelOf(tx, player);
      if (duel) runDuel(tx, duel, { type: 'PRESENCE_JOIN', playerId, nickname, role }, tx.ctx.now);
    }
    if (s.phase === 'LOBBY' && player.nickname !== nickname) {
      player.nickname = nickname;
      tx.changed = true;
    }
    return;
  }
  const spectator = s.spectators.find((x) => x.id === playerId);
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
    s.players.push(newSessionPlayer(playerId, nickname, false, tx.ctx.now));
  } else {
    // KH-1 / E-16 / E-31: room full or session running → spectator (seated at the next lobby).
    s.spectators.push({ id: playerId, nickname, connected: true, wantsToPlay, joinedAt: tx.ctx.now });
  }
  tx.changed = true;
}

function handleLeave(tx: STx, playerId: string): void {
  const s = tx.s;
  if (playerId === s.hostId) return; // GR-36 is handled by the HostRunner / guests
  const idx = s.players.findIndex((p) => p.id === playerId);
  if (idx >= 0) {
    const p = s.players[idx] as SessionPlayer;
    if (s.phase === 'LOBBY') {
      s.players.splice(idx, 1);
      tx.changed = true;
      promoteSpectators(tx);
    } else if (p.connected) {
      p.connected = false;
      p.disconnectedAt = tx.ctx.now;
      tx.changed = true;
      const duel = liveDuelOf(tx, p);
      if (duel) runDuel(tx, duel, { type: 'PRESENCE_LEAVE', playerId }, tx.ctx.now); // GR-35 inside the duel
    }
    return;
  }
  const sIdx = s.spectators.findIndex((x) => x.id === playerId);
  if (sIdx >= 0) {
    s.spectators.splice(sIdx, 1);
    tx.changed = true;
  }
}

/** Fills free seats with connected would-be players, in join order (lobby only). */
function promoteSpectators(tx: STx): void {
  const s = tx.s;
  if (s.phase !== 'LOBBY') return;
  const queue = s.spectators.filter((x) => x.wantsToPlay && x.connected).sort((a, b) => a.joinedAt - b.joinedAt);
  for (const x of queue) {
    if (s.players.length >= s.settings.maxPlayers) break;
    s.players.push(newSessionPlayer(x.id, x.nickname, false, x.joinedAt));
    s.spectators = s.spectators.filter((y) => y.id !== x.id);
    tx.changed = true;
  }
}

/** E-30: lowering the cap moves the most recent joiners (never the host) back to the seat queue. */
function demoteOverCap(tx: STx): void {
  const s = tx.s;
  while (s.players.length > s.settings.maxPlayers) {
    const victim = [...s.players].filter((p) => !p.isHost).sort((a, b) => b.joinedAt - a.joinedAt)[0];
    if (!victim) break;
    s.players = s.players.filter((p) => p.id !== victim.id);
    s.spectators.push({
      id: victim.id,
      nickname: victim.nickname,
      connected: victim.connected,
      wantsToPlay: true,
      joinedAt: victim.joinedAt,
    });
    tx.changed = true;
  }
}

function handleAbandon(tx: STx): void {
  const s = tx.s;
  if (s.phase !== 'IN_PROGRESS') return;
  for (const duel of activeDuels(s)) runDuel(tx, duel, { type: 'ABANDON' }, tx.ctx.now);
  s.phase = 'ABANDONED';
  s.finishedAt = tx.ctx.now;
  s.result = { outcome: 'abandoned', standings: [] };
  tx.changed = true;
  emit(tx, { type: 'SESSION_FINISHED', result: { outcome: 'abandoned', standings: [] } });
}

// -----------------------------------------------------------------------------------------------
// Client actions
// -----------------------------------------------------------------------------------------------

function handleClientAction(tx: STx, action: ClientAction): void {
  const actor = sp(tx, action.playerId);
  if (!actor) return reject(tx, action, 'not_a_player');
  if (!Number.isInteger(action.clientSeq) || action.clientSeq <= actor.lastSeq) {
    return reject(tx, action, 'duplicate_seq');
  }
  const prevSeq = actor.lastSeq;
  actor.lastSeq = action.clientSeq; // the next snapshot doubles as the ack
  tx.changed = true;

  switch (action.type) {
    case 'GUESS':
    case 'STEAL':
      return routeToDuel(tx, action, actor, prevSeq);
    case 'START':
      if (actor.id !== tx.s.hostId) return reject(tx, action, 'not_host');
      if (tx.s.phase !== 'LOBBY') return reject(tx, action, 'not_playing');
      if (!canStart(tx.s.players, tx.s.settings)) return reject(tx, action, 'not_enough_players');
      return startSession(tx);
    case 'REMATCH':
    case 'NEW_SESSION':
      return handleNewSession(tx, action, actor);
    case 'RETURN_TO_LOBBY':
      return handleReturnToLobby(tx, action, actor);
    case 'UPDATE_SETTINGS':
      return handleUpdateSettings(tx, action, actor);
  }
}

function routeToDuel(
  tx: STx,
  action: Extract<ClientAction, { type: 'GUESS' | 'STEAL' }>,
  actor: SessionPlayer,
  prevSeq: number,
): void {
  if (tx.s.phase !== 'IN_PROGRESS') return reject(tx, action, 'not_playing');
  // E-27: an action aimed at a previous duel never lands in the new one.
  if (action.duelId !== undefined && actor.duelId !== undefined && action.duelId !== actor.duelId) {
    return reject(tx, action, 'stale_duel');
  }
  if (actor.status === 'eliminated') return reject(tx, action, 'eliminated');
  if (actor.status === 'waiting' || !actor.duelId) return reject(tx, action, 'not_in_duel');
  const duel = liveDuelOf(tx, actor);
  if (!duel || actor.status !== 'dueling') return reject(tx, action, 'not_playing');
  // The session already checked the sequence number; keep the duel's own check consistent.
  const dp = duel.state.players.find((p) => p.id === actor.id);
  if (dp) dp.lastSeq = prevSeq;
  runDuel(tx, duel, action, tx.ctx.now);
}

function canStart(players: readonly SessionPlayer[], settings: GameSettings): boolean {
  return players.length >= 2 && players.length <= settings.maxPlayers && players.every((p) => p.connected);
}

function resetForSession(p: SessionPlayer): void {
  p.status = 'waiting';
  p.streak = 0;
  delete p.duelId;
  delete p.availableAt;
  delete p.eliminatedAt;
  delete p.eliminationReason;
  delete p.rank;
}

/** KH-2: shuffle, pair, and send the odd player out to the waiting room. */
function startSession(tx: STx): void {
  const s = tx.s;
  const now = tx.ctx.now;
  for (const p of s.players) resetForSession(p);
  s.duels = [];
  s.eliminationOrder = [];
  delete s.result;
  delete s.finalDuelId;
  delete s.finishedAt;
  s.sessionNumber += 1;
  s.phase = 'IN_PROGRESS';
  s.startedAt = now;
  tx.changed = true;
  emit(tx, { type: 'SESSION_STARTED', sessionNumber: s.sessionNumber });
  const ids = s.players.map((p) => p.id);
  // KH-14: two players are simply paired (no RNG draw), exactly like the 1.0 match.
  const { pairs, waiting } = ids.length === 2 ? { pairs: [ids as [string, string]], waiting: undefined } : shuffleAndPair(ids, tx.ctx.rng);
  for (const pair of pairs) createDuel(tx, pair, now);
  if (waiting) emit(tx, { type: 'WAITING', playerId: waiting });
}

/** KH-13: same room, every connected player (eliminated ones included) back into the shuffle. */
function handleNewSession(
  tx: STx,
  action: Extract<ClientAction, { type: 'REMATCH' | 'NEW_SESSION' }>,
  actor: SessionPlayer,
): void {
  const s = tx.s;
  if (actor.id !== s.hostId) return reject(tx, action, 'not_host');
  if (s.phase !== 'FINISHED') return reject(tx, action, 'not_playing');
  // Validate before mutating: who would be seated?
  const seated = s.players.filter((p) => p.connected || p.id === s.hostId);
  const waitingSeats = s.spectators
    .filter((x) => x.wantsToPlay && x.connected)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .slice(0, Math.max(0, s.settings.maxPlayers - seated.length));
  if (!canStart([...seated, ...waitingSeats.map((x) => newSessionPlayer(x.id, x.nickname, false, x.joinedAt))], s.settings)) {
    return reject(tx, action, 'not_enough_players');
  }
  s.players = seated;
  s.phase = 'LOBBY'; // promote late joiners (E-31) through the normal lobby path
  promoteSpectators(tx);
  startSession(tx);
}

function handleReturnToLobby(
  tx: STx,
  action: Extract<ClientAction, { type: 'RETURN_TO_LOBBY' }>,
  actor: SessionPlayer,
): void {
  const s = tx.s;
  if (actor.id !== s.hostId) return reject(tx, action, 'not_host');
  if (s.phase !== 'FINISHED' && s.phase !== 'ABANDONED') return reject(tx, action, 'not_playing');
  s.phase = 'LOBBY';
  s.players = s.players.filter((p) => p.connected || p.id === s.hostId);
  for (const p of s.players) resetForSession(p);
  s.duels = [];
  s.eliminationOrder = [];
  delete s.result;
  delete s.finalDuelId;
  delete s.startedAt;
  delete s.finishedAt;
  tx.changed = true;
  promoteSpectators(tx);
}

function handleUpdateSettings(
  tx: STx,
  action: Extract<ClientAction, { type: 'UPDATE_SETTINGS' }>,
  actor: SessionPlayer,
): void {
  const s = tx.s;
  if (actor.id !== s.hostId) return reject(tx, action, 'not_host');
  if (s.phase !== 'LOBBY') return reject(tx, action, 'not_playing');
  try {
    s.settings = resolveSettings(action.patch ?? {}, s.settings);
  } catch (err) {
    if (err instanceof InvalidSettingsError) return reject(tx, action, 'invalid_settings');
    throw err;
  }
  tx.changed = true;
  demoteOverCap(tx);
  promoteSpectators(tx);
}
