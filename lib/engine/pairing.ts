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

// -----------------------------------------------------------------------------------------------
// v1.1 King of the hill (KH-2, KH-3, KH-10): who duels whom inside a session.
// -----------------------------------------------------------------------------------------------

/** Fisher–Yates shuffle with the injected RNG (NFR-8: deterministic per seed). Returns a copy. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * KH-2: shuffle the seated players and pair them in order (1,2), (3,4), … With an odd count the
 * last shuffled player — a random one — is left over for the waiting room.
 */
export function shuffleAndPair(ids: readonly string[], rng: () => number): { pairs: [string, string][]; waiting?: string } {
  const order = shuffle(ids, rng);
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i] as string, order[i + 1] as string]);
  return { pairs, waiting: order.length % 2 ? order.at(-1) : undefined };
}

/**
 * KH-9 / KH-10a: pairs available players in priority order (the waiting player first, then
 * hill-holders whose result beat ended, earliest first). Symmetric by construction; at most one
 * player is left over, so the waiting room never holds more than one player.
 */
export function pairAvailable(ids: readonly string[]): { pairs: [string, string][]; waiting?: string } {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < ids.length; i += 2) pairs.push([ids[i] as string, ids[i + 1] as string]);
  return { pairs, waiting: ids.length % 2 ? ids.at(-1) : undefined };
}
