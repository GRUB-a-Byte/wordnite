import type { PublicPlayer } from './types';

/**
 * Opponent selection (FIX 2). Kept apart from scoring and win evaluation so a future knockout /
 * battle-royale release can swap in its own strategy (random assignment, bracket pairings, …)
 * without touching the rest of the engine.
 *
 * Release 1.0 — "duel" pairing: there are exactly two players and each one targets the other.
 */
export function computeTargets(players: readonly PublicPlayer[]): Map<string, string | undefined> {
  const targets = new Map<string, string | undefined>();
  for (const p of players) {
    const opponent = players.find((o) => o.id !== p.id);
    targets.set(p.id, opponent?.id);
  }
  return targets;
}

/** Writes `targetId` on every player record (mutates the given draft records). */
export function applyPairing(players: PublicPlayer[]): void {
  const targets = computeTargets(players);
  for (const p of players) p.targetId = targets.get(p.id);
}

/** Whether `stealerId` is currently allowed to aim at `targetId` (identity check only — status rules live in the reducer). */
export function isAssignedTarget(players: readonly PublicPlayer[], stealerId: string, targetId: string): boolean {
  if (stealerId === targetId) return false;
  const stealer = players.find((p) => p.id === stealerId);
  return !!stealer && stealer.targetId === targetId && players.some((p) => p.id === targetId);
}
