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
