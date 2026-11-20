/**
 * Word Royale engine types.
 *
 * FIX 1 (secret redaction): the authoritative state lives ONLY in the host browser as
 * `PrivateGameState`. Everything that goes over the wire is a `PublicGameState`, produced by
 * `toPublicState()` in ./project.ts, which never contains a secret word until the match is FINISHED.
 *
 * This module has no runtime code and no React / Supabase / browser imports (NFR-13).
 */

export type TileState = 'correct' | 'present' | 'absent';

export type Phase = 'LOBBY' | 'COUNTDOWN' | 'PLAYING' | 'OVERTIME' | 'FINISHED' | 'ABANDONED';

export type PlayerStatus = 'alive' | 'invulnerable' | 'eliminated';

export type EliminationReason = 'stolen' | 'out_of_rows' | 'forfeit';

/** FIX 3: all rule constants are plain numbers/booleans, validated by `validateSettings()`. */
export interface GameSettings {
  wordLength: number; // GR-11
  baseRows: number; // GR-3
  overtimeExtraRows: number; // GR-31
  postSolveStealRows: number; // GR-18
  countdownMs: number; // GR-4
  matchMs: number; // GR-5
  overtimeMs: number; // GR-31
  guestGraceMs: number; // GR-35
  hostGraceMs: number; // GR-36
  maxPlayers: number; // GR-1 (2 in release 1.0)
  /** GR-28 "unbeatable" early finish. FIX 5: isolated behind this flag for playtesting. */
  enableUnbeatableEarlyFinish: boolean;
}

export interface Row {
  id: string;
  word: string; // upper-case
  tiles: TileState[]; // length = wordLength
  kind: 'own' | 'steal';
  targetId: string; // == owner id for 'own'
  scoring: boolean; // false for post-solve steal rows (GR-21)
  at: number; // host timestamp
  hit: boolean; // own: solved with this row; steal: stole the target's word with this row
}

/** Fields of a player that are safe to show to everyone. */
export interface PublicPlayer {
  id: string;
  nickname: string;
  isHost: boolean;
  connected: boolean;
  disconnectedAt?: number;
  status: PlayerStatus;
  rows: Row[];
  rowLimit: number; // baseRows, + overtimeExtraRows after overtime
  rowsUsed: number; // scoring rows only
  postSolveStealRows: number; // 0 until solved, then postSolveStealRows and counts down
  solvedInRows?: number;
  solvedAt?: number;
  /** Host processing order of the solving row — final FIFO tie-break if two solves share a millisecond. */
  solveOrder?: number;
  eliminatedAt?: number;
  eliminatedBy?: string; // stealer id
  eliminationReason?: EliminationReason;
  /** Opponent whose board this player sees / can steal from (pairing module; N-player ready). */
  targetId?: string;
  /** Highest clientSeq the host has processed for this player (acts as the action ack, FIX 6). */
  lastSeq: number;
}

/** Referee-only player record. `secret` must never leave the host except via FINISHED reveal. */
export interface PrivatePlayer extends PublicPlayer {
  secret: string;
}

export interface Spectator {
  id: string;
  nickname: string;
  connected: boolean;
  /** True when this person wanted to play but the room was full (may be promoted in the lobby). */
  wantsToPlay: boolean;
  joinedAt: number;
}

export type OutcomeReason =
  | 'stolen'
  | 'fewer_rows'
  | 'same_rows_earlier'
  | 'opponent_out_of_rows'
  | 'unbeatable'
  | 'timeout_solver'
  | 'forfeit'
  | 'overtime_expired'
  | 'all_eliminated'
  | 'abandoned';

export interface GameResult {
  outcome: 'win' | 'draw' | 'abandoned';
  winnerId?: string;
  loserId?: string;
  reason: OutcomeReason;
}

export type GameEvent =
  | { id: number; type: 'MATCH_STARTED'; matchNumber: number }
  | { id: number; type: 'PLAY_STARTED' }
  | { id: number; type: 'ROW_ADDED'; playerId: string; rowId: string }
  | { id: number; type: 'SOLVED'; playerId: string; rows: number }
  | { id: number; type: 'STEAL_MISS'; stealerId: string; targetId: string; rowId: string }
  | { id: number; type: 'STEAL_HIT'; stealerId: string; targetId: string; rowId: string }
  | { id: number; type: 'ELIMINATED'; playerId: string; reason: EliminationReason }
  | { id: number; type: 'OVERTIME_START'; extraRows: number }
  | { id: number; type: 'FINISHED'; result: GameResult };

/** Distributive Omit so each GameEvent variant keeps its own fields. */
export type GameEventInput = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, 'id'> : never) : never;

interface GameStateBase {
  roomCode: string;
  /** Monotonically increasing; bumped on every state change (clients drop stale snapshots). */
  version: number;
  hostId: string;
  phase: Phase;
  /** Absolute host-clock deadline of the current COUNTDOWN / PLAYING / OVERTIME phase. */
  phaseEndsAt?: number;
  overtimeUsed: boolean; // GR-34
  settings: GameSettings;
  spectators: Spectator[];
  result?: GameResult;
  /** Events produced by the most recent state change (drives synchronized animations). */
  lastEvents: GameEvent[];
  matchNumber: number; // increments on every START / REMATCH
  /** Host time when PLAYING began / the match finished (FIX 5: match duration is observable). */
  playStartedAt?: number;
  finishedAt?: number;
}

export interface PrivateGameState extends GameStateBase {
  players: PrivatePlayer[]; // ordered by join
  /** Counter for generating deterministic row ids. */
  rowCounter: number;
  /** Counter for event ids. */
  eventCounter: number;
}

export interface PublicGameState extends GameStateBase {
  players: PublicPlayer[];
  /** Host clock at broadcast time (clients derive their clock offset from it). */
  hostNow: number;
  /** Secrets keyed by player id — present ONLY when phase === 'FINISHED'. */
  revealedSecrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export type ClientAction =
  | { type: 'START'; playerId: string; clientSeq: number }
  | { type: 'GUESS'; playerId: string; word: string; clientSeq: number }
  | { type: 'STEAL'; playerId: string; targetId: string; word: string; clientSeq: number }
  | { type: 'REMATCH'; playerId: string; clientSeq: number }
  | { type: 'RETURN_TO_LOBBY'; playerId: string; clientSeq: number }
  | { type: 'UPDATE_SETTINGS'; playerId: string; clientSeq: number; patch: Partial<GameSettings> };

export type PresenceRole = 'host' | 'player' | 'spectator';

export type EngineAction =
  | ClientAction
  | { type: 'TICK' }
  | { type: 'PRESENCE_JOIN'; playerId: string; nickname: string; role: PresenceRole }
  | { type: 'PRESENCE_LEAVE'; playerId: string }
  /** Host lost its own connection / came back too late (GR-36). */
  | { type: 'ABANDON' };

export type RejectReason =
  | 'invalid_word'
  | 'duplicate'
  | 'duplicate_seq'
  | 'target_shielded'
  | 'target_eliminated'
  | 'invalid_target'
  | 'no_ammo'
  | 'no_rows'
  | 'not_playing'
  | 'eliminated'
  | 'already_solved'
  | 'not_host'
  | 'not_a_player'
  | 'not_enough_players'
  | 'invalid_settings';

export interface Rejection {
  playerId: string;
  clientSeq: number;
  reason: RejectReason;
}

export interface WordDictionary {
  /** Upper-case 5-letter words that may be guessed (GR-12). */
  isValid(word: string): boolean;
  /** Candidate secret words (GR-2). */
  answers: readonly string[];
}

export interface EngineContext {
  /** Authoritative host time (ms). Injected — the engine never calls Date.now() (NFR-8). */
  now: number;
  /** Random source in [0, 1). Injected — the engine never calls Math.random() (NFR-8). */
  rng: () => number;
  dictionary: WordDictionary;
}

export interface ReduceResult {
  state: PrivateGameState;
  rejections: Rejection[];
  events: GameEvent[];
  changed: boolean;
}
