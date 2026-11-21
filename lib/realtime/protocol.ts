import type { ClientAction, GameSettings, PresenceRole, PublicSessionState, Rejection } from '@/lib/engine/types';

/**
 * Wire protocol over the `room:{CODE}` channel (SRS §8.3, amended by FIX 1).
 *
 * | event          | direction      | payload                                   |
 * |----------------|----------------|-------------------------------------------|
 * | `action`       | client → host  | ClientAction                              |
 * | `state`        | host → all     | PublicSessionState (never active secrets) |
 * | `reject`       | host → all     | Rejection (clients filter by playerId)    |
 * | `draft`        | player → all   | DraftPayload (ephemeral, not refereed)    |
 * | `sync_request` | client → host  | { playerId }                              |
 */
export interface DraftPayload {
  playerId: string;
  letters: string;
  mode: 'own' | 'steal';
  targetId?: string;
  /** Duel number — drafts are only rendered inside the duel they were typed in. */
  matchNumber: number;
  duelId?: string;
}

export interface EventPayloads {
  action: ClientAction;
  state: PublicSessionState;
  reject: Rejection;
  draft: DraftPayload;
  sync_request: { playerId: string };
}

export type EventName = keyof EventPayloads;
export const EVENT_NAMES: readonly EventName[] = ['action', 'state', 'reject', 'draft', 'sync_request'];

export interface PresenceMeta {
  playerId: string;
  nickname: string;
  role: PresenceRole;
  joinedAt: number;
}

// -------------------------------------------------------------------------------------------------
// Runtime validation of untrusted payloads. Anyone holding the anon key can publish on a channel, so
// the host validates the SHAPE of every action before it reaches the engine (the engine then
// validates the RULES). This is prototype-grade: it does not authenticate the sender (see
// docs/ARCHITECTURE.md → "Security limitations").
// -------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e9;
const isWord = (v: unknown): v is string => typeof v === 'string' && v.length <= 16;

const SETTINGS_KEYS: readonly (keyof GameSettings)[] = [
  'wordLength',
  'baseRows',
  'overtimeExtraRows',
  'postSolveStealRows',
  'countdownMs',
  'matchMs',
  'overtimeMs',
  'guestGraceMs',
  'hostGraceMs',
  'maxPlayers',
  'enableUnbeatableEarlyFinish',
  'resultBeatMs',
];

export function parseClientAction(raw: unknown): ClientAction | null {
  if (!isObj(raw) || !isId(raw.playerId) || !isSeq(raw.clientSeq)) return null;
  const base = { playerId: raw.playerId, clientSeq: raw.clientSeq };
  switch (raw.type) {
    case 'START':
    case 'NEW_SESSION':
    case 'RETURN_TO_LOBBY':
      return { type: raw.type, ...base };
    case 'REMATCH':
      return { type: 'NEW_SESSION', ...base }; // KH-13: 1.0 clients' Rematch is a New session
    case 'GUESS': {
      if (!isWord(raw.word)) return null;
      const a: ClientAction = { type: 'GUESS', ...base, word: raw.word };
      if (isId(raw.duelId)) a.duelId = raw.duelId;
      return a;
    }
    case 'STEAL': {
      if (!isWord(raw.word) || !isId(raw.targetId)) return null;
      const a: ClientAction = { type: 'STEAL', ...base, word: raw.word, targetId: raw.targetId };
      if (isId(raw.duelId)) a.duelId = raw.duelId;
      return a;
    }
    case 'UPDATE_SETTINGS': {
      if (!isObj(raw.patch)) return null;
      const patch: Partial<GameSettings> = {};
      for (const key of SETTINGS_KEYS) {
        const v = raw.patch[key];
        if (typeof v === 'number' || typeof v === 'boolean') (patch as Record<string, unknown>)[key] = v;
      }
      return { type: 'UPDATE_SETTINGS', ...base, patch };
    }
    default:
      return null;
  }
}

export function parsePresenceMeta(raw: unknown): PresenceMeta | null {
  if (!isObj(raw) || !isId(raw.playerId)) return null;
  const role = raw.role === 'host' || raw.role === 'player' || raw.role === 'spectator' ? raw.role : null;
  if (!role) return null;
  return {
    playerId: raw.playerId,
    nickname: typeof raw.nickname === 'string' ? raw.nickname.slice(0, 16) : 'Player',
    role,
    joinedAt: typeof raw.joinedAt === 'number' ? raw.joinedAt : 0,
  };
}

export function parseDraft(raw: unknown): DraftPayload | null {
  if (!isObj(raw) || !isId(raw.playerId) || typeof raw.letters !== 'string') return null;
  return {
    playerId: raw.playerId,
    letters: raw.letters.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5),
    mode: raw.mode === 'steal' ? 'steal' : 'own',
    targetId: isId(raw.targetId) ? raw.targetId : undefined,
    matchNumber: typeof raw.matchNumber === 'number' ? raw.matchNumber : 0,
    duelId: isId(raw.duelId) ? raw.duelId : undefined,
  };
}

export function looksLikePublicSession(raw: unknown): raw is PublicSessionState {
  return (
    isObj(raw) &&
    typeof raw.version === 'number' &&
    typeof raw.roomCode === 'string' &&
    typeof raw.hostId === 'string' &&
    typeof raw.phase === 'string' &&
    Array.isArray(raw.players) &&
    Array.isArray(raw.duels) &&
    Array.isArray(raw.lastEvents)
  );
}

export function parseRejection(raw: unknown): Rejection | null {
  if (!isObj(raw) || !isId(raw.playerId) || typeof raw.clientSeq !== 'number' || typeof raw.reason !== 'string') {
    return null;
  }
  return raw as unknown as Rejection;
}
