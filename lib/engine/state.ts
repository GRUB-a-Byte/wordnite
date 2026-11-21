import { DEFAULT_SETTINGS, validateSettings } from './settings';
import type { GameSettings, Phase, PrivateGameState, PrivatePlayer } from './types';

/** Phases in which the match clock runs and players can be eliminated. */
export function isActivePhase(phase: Phase): boolean {
  return phase === 'COUNTDOWN' || phase === 'PLAYING' || phase === 'OVERTIME';
}

/** Phases in which GUESS / STEAL are accepted (GR-14). */
export function isPlayPhase(phase: Phase): boolean {
  return phase === 'PLAYING' || phase === 'OVERTIME';
}

/** A duel is exactly two players; anything bigger plays by the battle-royale rules (SRS addendum Z.9). */
export function isBattleRoyale(playerCount: number): boolean {
  return playerCount > 2;
}

/** A spectator still in the room who asked to play — in line for the next free seat. */
export function isWaitingForSeat(sp: { connected: boolean; wantsToPlay: boolean }): boolean {
  return sp.connected && sp.wantsToPlay;
}

/** Minimal shape shared by the private (referee) and public (client) game state. */
interface RosterView {
  hostId: string;
  players: readonly { id: string; connected: boolean }[];
  spectators: readonly { connected: boolean; wantsToPlay: boolean }[];
  settings: { maxPlayers: number };
}

/** Players still in the room (the host always counts). */
export function playersStillHere<P extends { id: string; connected: boolean }>(players: readonly P[], hostId: string): P[] {
  return players.filter((p) => p.connected || p.id === hostId);
}

/**
 * How many people the next match would have if the host started it now: players still here plus
 * spectators waiting for a seat, capped at maxPlayers. The referee (REMATCH) and the end screen use
 * this same rule, so the "Next match: N players" label is always what actually happens.
 */
export function nextMatchSize(s: RosterView): number {
  const here = playersStillHere(s.players, s.hostId).length;
  const waiting = s.spectators.filter(isWaitingForSeat).length;
  return Math.min(s.settings.maxPlayers, here + waiting);
}

export function newPlayer(id: string, nickname: string, isHost: boolean, settings: GameSettings): PrivatePlayer {
  return {
    id,
    nickname,
    isHost,
    connected: true,
    status: 'alive',
    rows: [],
    rowLimit: settings.baseRows,
    rowsUsed: 0,
    postSolveStealRows: 0,
    lastSeq: 0,
    secret: '',
  };
}

/** Clears every per-match field (GR-3 / GR-37) but keeps identity, connection and the seq ack. */
export function resetPlayerForMatch(p: PrivatePlayer, settings: GameSettings, secret: string): void {
  p.status = 'alive';
  p.rows = [];
  p.rowLimit = settings.baseRows;
  p.rowsUsed = 0;
  p.postSolveStealRows = 0;
  p.secret = secret;
  delete p.solvedInRows;
  delete p.solvedAt;
  delete p.solveOrder;
  delete p.eliminatedAt;
  delete p.eliminatedBy;
  delete p.eliminationReason;
  delete p.disconnectedAt;
}

export interface CreateRoomInput {
  roomCode: string;
  hostId: string;
  hostNickname: string;
  settings?: GameSettings;
}

export function createLobbyState(input: CreateRoomInput): PrivateGameState {
  const settings = validateSettings({ ...(input.settings ?? DEFAULT_SETTINGS) });
  return {
    roomCode: input.roomCode,
    version: 1,
    hostId: input.hostId,
    phase: 'LOBBY',
    overtimeUsed: false,
    settings,
    players: [newPlayer(input.hostId, input.hostNickname, true, settings)],
    spectators: [],
    lastEvents: [],
    matchNumber: 0,
    rowCounter: 0,
    eventCounter: 0,
  };
}
