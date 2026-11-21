import type { Phase, PlayerStatus } from '@/lib/engine/types';

/**
 * FR-4.2a — Spacebar power-user shortcut: toggles own guess ⇄ steal.
 *
 * Pure so the eligibility rules are unit-tested. Steal-mode eligibility itself (shielded or
 * eliminated target, no ammo) is checked by `RoomClient.setMode()`, exactly as for Tab and clicks,
 * which shows the reason as a hint.
 */
export interface SpaceContext {
  phase?: Phase;
  status?: PlayerStatus;
  /** KeyboardEvent.repeat — holding Space must not flicker the mode. */
  repeat: boolean;
}

export type SpaceDecision = 'toggle' | 'ignore';

export function spaceAction(ctx: SpaceContext): SpaceDecision {
  if (ctx.repeat) return 'ignore';
  if (ctx.phase !== 'PLAYING' && ctx.phase !== 'OVERTIME') return 'ignore';
  if (ctx.status !== 'alive') return 'ignore'; // shielded = steal-only (FR-4.7); eliminated = no input
  return 'toggle';
}

/** Text fields keep Space for typing (e.g. the nickname box); the game handler skips them. */
export function isTextEntryTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
}

export function isSpaceKey(e: { key: string; code?: string }): boolean {
  return e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';
}
