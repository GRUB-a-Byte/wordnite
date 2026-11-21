import type { PublicPlayer } from '@/lib/engine/types';

/** Small pure helpers over the public player list, shared by components and the controller. */

export function findPlayer<P extends PublicPlayer>(players: readonly P[], id: string | undefined): P | undefined {
  return id === undefined ? undefined : players.find((p) => p.id === id);
}

/** Nickname for an id, or `fallback` when the player is unknown (e.g. already left). */
export function nicknameOf(players: readonly PublicPlayer[], id: string | undefined, fallback = '?'): string {
  return findPlayer(players, id)?.nickname ?? fallback;
}

/** How the arena stands: still alive (stealable), shielded (solved), and knocked out. */
export function arenaCounts(players: readonly PublicPlayer[]): { alive: number; shielded: number; out: number } {
  let alive = 0;
  let shielded = 0;
  for (const p of players) {
    if (p.status === 'alive') alive++;
    else if (p.status === 'invulnerable') shielded++;
  }
  return { alive, shielded, out: players.length - alive - shielded };
}
