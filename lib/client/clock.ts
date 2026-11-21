import { isBattleRoyale } from '@/lib/engine/state';
import type { Phase, PlayerStatus, PublicGameState, PublicPlayer } from '@/lib/engine/types';

/**
 * v1.1 FD-7: which clock a viewer sees. A 2-player match has one match clock (`phaseEndsAt`).
 * In a battle royale there is NO match clock: every duel has its own countdown / clock / overtime,
 * stored on both of its players. A waiting player has no clock at all (WR-5).
 */
export interface Clock {
  phase?: Phase;
  endsAt?: number;
}

export function clockOf(game: PublicGameState | null | undefined, player?: PublicPlayer): Clock {
  if (!game) return {};
  if (!isBattleRoyale(game.players.length)) return { phase: game.phase, endsAt: game.phaseEndsAt };
  if (game.phase !== 'PLAYING' || !player?.duelPhase) return {};
  return { phase: player.duelPhase, endsAt: player.duelEndsAt };
}

/** GUESS / STEAL can be accepted on this clock (GR-14, FD-7). */
export function isPlayClock(c: Clock): boolean {
  return c.phase === 'PLAYING' || c.phase === 'OVERTIME';
}

/**
 * FR-4.2a — Spacebar toggles own ⇄ steal. Pure so the rules are unit-tested. Steal eligibility
 * itself (shielded / eliminated opponent, no ammo) is checked by RoomClient.setMode(), exactly as
 * for Tab, which shows the reason as a toast.
 */
export function spaceAction(ctx: {
  clockPhase?: Phase;
  status?: PlayerStatus;
  waiting: boolean;
  repeat: boolean;
}): 'toggle' | 'ignore' {
  if (ctx.repeat || ctx.waiting) return 'ignore';
  if (ctx.clockPhase !== 'PLAYING' && ctx.clockPhase !== 'OVERTIME') return 'ignore';
  if (ctx.status !== 'alive') return 'ignore'; // shielded = steal-only (FR-4.7); eliminated = no input
  return 'toggle';
}

/** Text fields keep Space for typing (e.g. the nickname box). */
export function isTextEntryTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
}

export function isSpaceKey(e: { key: string; code?: string }): boolean {
  return e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';
}
