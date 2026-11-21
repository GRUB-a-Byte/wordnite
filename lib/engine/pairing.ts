import { randomInt } from './rng';
import type { PublicPlayer } from './types';

/**
 * Who fights whom: SYMMETRIC PAIRS (battle royale, SRS §13 as amended by Z.11 and v1.1).
 *
 * Every player in the arena fights exactly ONE opponent (`targetId`), and opponents are mutual:
 * if A's opponent is B, then B's opponent is A. Each pair is a DUEL. Nobody chooses: the referee
 * pairs players automatically and at random (seeded rng, so a match replays identically — NFR-8).
 *
 *  - Match start: players are shuffled and paired off. With an odd number, one player waits.
 *  - v1.1 FD-6: a pair lasts until one of the two is out of the battle — there is no more "split
 *    when neither can steal". The survivor then waits, and is paired at random with the next free
 *    player. Every new pair starts a FRESH duel (new words, blank boards — the reducer does that).
 *  - v1.1 WR-1: a player with no opponent is waiting and can take no action (reducer + client).
 *  - Two players → they are each other's opponent for the whole match (the classic duel).
 *
 * Invariant (checked by the tests): for every player still in play, `targetId` is either unset or
 * names a player still in play whose `targetId` names them back. Eliminated players keep their
 * last opponent (for the end screen and for watching).
 */
export function isStealable(p: PublicPlayer | undefined): boolean {
  return !!p && p.status === 'alive';
}

/** Can still send steals: unsolved (out of rows means eliminated), or solved with free steal shots left. */
export function canAttack(p: PublicPlayer): boolean {
  return p.status === 'alive' || (p.status === 'invulnerable' && p.postSolveStealRows > 0);
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * (Re)pairs players in place: keeps every pair whose two players are both still in the battle, then
 * pairs the free players at random (any status — a duel winner is reset when the new duel starts).
 * Returns the ids of players whose opponent changed.
 *
 * @param fresh  forget all existing pairs (match start)
 */
export function pairPlayers(players: PublicPlayer[], rng: () => number, fresh = false): string[] {
  const before = new Map(players.map((p) => [p.id, p.targetId]));
  if (fresh) for (const p of players) delete p.targetId;
  const byId = new Map(players.map((p) => [p.id, p]));
  const inPlay = players.filter((p) => p.status !== 'eliminated');

  // 1. Keep the pairs that still hold: both in play and mutual.
  for (const p of inPlay) {
    const o = p.targetId ? byId.get(p.targetId) : undefined;
    if (!o || o.status === 'eliminated' || o.targetId !== p.id) delete p.targetId;
  }

  // 2. Pair the free players at random; with an odd number one is left waiting.
  const free = shuffled(
    inPlay.filter((p) => !p.targetId),
    rng,
  );
  while (free.length >= 2) {
    const a = free.pop() as PublicPlayer;
    const b = free.pop() as PublicPlayer;
    a.targetId = b.id;
    b.targetId = a.id;
  }

  return players.filter((p) => p.targetId !== before.get(p.id)).map((p) => p.id);
}

/** Whether `targetId` is `stealerId`'s current opponent: the only player they may steal from. */
export function isOpponent(players: readonly PublicPlayer[], stealerId: string, targetId: string): boolean {
  if (stealerId === targetId) return false;
  const stealer = players.find((p) => p.id === stealerId);
  return !!stealer && stealer.targetId === targetId && players.some((p) => p.id === targetId);
}
