import { randomInt } from './rng';
import { isBattleRoyale } from './state';
import type { PublicPlayer } from './types';

/**
 * Who fights whom: SYMMETRIC PAIRS (battle royale, SRS §13 as amended).
 *
 * Every player in the arena fights exactly ONE opponent (`targetId`), and opponents are mutual:
 * if A's opponent is B, then B's opponent is A; if C's is D, D's is C; and so on. Each pair is a
 * duel inside the arena. Nobody chooses: the referee pairs players automatically and at random
 * (seeded rng, so a match replays identically — NFR-8).
 *
 *  - Match start: players are shuffled and paired off. With an odd number, one player waits for an
 *    opponent; they keep solving their own word, and nobody can steal from them meanwhile.
 *  - A pair lasts until one of the two is out (stolen, out of rows, forfeit). The survivor is then
 *    paired, at random, with another free player, or waits until one is free.
 *  - Free unsolved players are paired with each other first (two-way fights). A lone unsolved
 *    player may be paired with a solved player who still has free steal shots.
 *  - Battle royale only: a pair in which neither player can steal from the other any more (e.g. one
 *    solved and has used all their free steal shots) splits up, so both can be paired again.
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

/** A pair can still fight while at least one of them can steal from the other. */
function canFight(a: PublicPlayer, b: PublicPlayer): boolean {
  return (isStealable(b) && canAttack(a)) || (isStealable(a) && canAttack(b));
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
 * (Re)pairs players in place: keeps every pair that still holds, then pairs free players at
 * random. Returns the ids of players whose opponent changed (for "new opponent" notices).
 *
 * @param fresh  forget all existing pairs (match start)
 */
export function pairPlayers(players: PublicPlayer[], rng: () => number, fresh = false): string[] {
  const before = new Map(players.map((p) => [p.id, p.targetId]));
  if (fresh) for (const p of players) delete p.targetId;
  const byId = new Map(players.map((p) => [p.id, p]));
  const inPlay = players.filter((p) => p.status !== 'eliminated');
  const royale = isBattleRoyale(players.length);

  // 1. Keep the pairs that still hold: both in play, mutual, and (battle royale) still able to fight.
  for (const p of inPlay) {
    const o = p.targetId ? byId.get(p.targetId) : undefined;
    const holds = !!o && o.status !== 'eliminated' && o.targetId === p.id && (!royale || canFight(p, o));
    if (!holds) delete p.targetId;
  }
  // A partner whose pair was just dropped above must drop it too (keeps pairs mutual).
  for (const p of inPlay) {
    const o = p.targetId ? byId.get(p.targetId) : undefined;
    if (!o || o.targetId !== p.id) delete p.targetId;
  }

  // 2. Pair the free players at random: unsolved with unsolved first, then a lone unsolved player
  //    with a solved player who still has free steal shots.
  const free = shuffled(
    inPlay.filter((p) => !p.targetId && canAttack(p)),
    rng,
  );
  const pair = (a: PublicPlayer, b: PublicPlayer) => {
    a.targetId = b.id;
    b.targetId = a.id;
  };
  const unsolved = free.filter(isStealable);
  while (unsolved.length >= 2) pair(unsolved.pop() as PublicPlayer, unsolved.pop() as PublicPlayer);
  const lone = unsolved[0];
  const shooter = free.find((p) => p.status === 'invulnerable');
  if (lone && shooter) pair(lone, shooter);

  return players.filter((p) => p.targetId !== before.get(p.id)).map((p) => p.id);
}

/** Whether `targetId` is `stealerId`'s current opponent: the only player they may steal from. */
export function isOpponent(players: readonly PublicPlayer[], stealerId: string, targetId: string): boolean {
  if (stealerId === targetId) return false;
  const stealer = players.find((p) => p.id === stealerId);
  return !!stealer && stealer.targetId === targetId && players.some((p) => p.id === targetId);
}
