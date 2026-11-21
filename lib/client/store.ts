import { create } from 'zustand';
import type { PresenceRole, PublicGameState, PublicPlayer, PublicSessionState, RoomEvent } from '@/lib/engine/types';
import type { DraftPayload, PresenceMeta } from '@/lib/realtime/protocol';
import type { TransportStatus } from '@/lib/realtime/transport';
import type { ViewKind } from './view';

export type InputMode = 'own' | 'steal';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success' | 'warn';
}

export interface PendingSubmission {
  clientSeq: number;
  duelId?: string;
  word: string;
  kind: 'own' | 'steal';
  targetId: string;
  sentAt: number;
  syncRequested: boolean;
  resent: boolean;
}

export interface FxEntry {
  id: number;
  event: RoomEvent;
  at: number;
}

export interface RoomState {
  roomCode: string;
  me: string;
  nickname: string;
  role: PresenceRole;
  debug: boolean;

  connection: TransportStatus;
  transportKind: 'supabase' | 'local' | null;
  configError: string | null;
  presence: PresenceMeta[];
  hostPresent: boolean;
  /** GR-36 (client side): host gone longer than hostGraceMs. Cleared by any newer host state. */
  localAbandoned: boolean;
  /** E-17: no host appeared within 5 s. */
  roomNotFound: boolean;

  /** v1.1: the authoritative session snapshot (every duel the viewer may need). */
  session: PublicSessionState | null;
  /** Which screen this viewer is on (see lib/client/view.ts). */
  view: ViewKind;
  /** Id of the duel on screen (sent with GUESS / STEAL so a stale action can't hit a new duel). */
  viewDuelId?: string;
  /** The duel on screen in 1.0 shape (or the lobby roster) — what the 1.0 components render. */
  game: PublicGameState | null;
  /** host clock − local clock (ms). */
  clockOffset: number;

  mode: InputMode;
  draft: string;
  pending: PendingSubmission | null;
  /** Result card the viewer skipped with "Spectate" (FR-6.5). */
  dismissedDuelId?: string;
  /** Increments to trigger the invalid-row shake. */
  shake: number;
  drafts: Record<string, DraftPayload>;
  toasts: Toast[];
  fx: FxEntry[];
  /** Submission → authoritative confirmation latencies (ms), most recent last (FIX 4). */
  latencies: number[];
  dictionaryReady: boolean;
}

export const initialRoomState = (): RoomState => ({
  roomCode: '',
  me: '',
  nickname: '',
  role: 'player',
  debug: false,
  connection: 'connecting',
  transportKind: null,
  configError: null,
  presence: [],
  hostPresent: false,
  localAbandoned: false,
  roomNotFound: false,
  session: null,
  view: 'none',
  game: null,
  clockOffset: 0,
  mode: 'own',
  draft: '',
  pending: null,
  shake: 0,
  drafts: {},
  toasts: [],
  fx: [],
  latencies: [],
  dictionaryReady: false,
});

export const useRoom = create<RoomState>(() => initialRoomState());

// ---------------------------------------------------------------------------------------------
// Derived selectors (pure helpers so components and the controller agree)
// ---------------------------------------------------------------------------------------------

export function myPlayer(s: Pick<RoomState, 'game' | 'me'>): PublicPlayer | undefined {
  return s.game?.players.find((p) => p.id === s.me);
}

export function targetOf(s: Pick<RoomState, 'game' | 'me'>): PublicPlayer | undefined {
  const me = myPlayer(s);
  if (!s.game) return undefined;
  if (me?.targetId) return s.game.players.find((p) => p.id === me.targetId);
  return s.game.players.find((p) => p.id !== s.me);
}

export function hostNow(s: Pick<RoomState, 'clockOffset'>): number {
  return Date.now() + s.clockOffset;
}
