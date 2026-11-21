import { randomInt } from './rng';
import type { PublicPlayer } from './types';

/**
 * Who may attack whom (FIX 2 extension point — battle royale, SRS §13 as amended).
 *
 * Every active player gets a PERSONAL, RANDOM SHORTLIST (`targetOptions`) of up to
 * `settings.targetChoices` (3) opponents they may attack, and CHOOSES one of them (`targetId`) —
 * that is the board they see and where their steals go.
 *
 *  - Shortlists only contain players who are still `alive`: never spectators (they are not in the
 *    player list at all), eliminated players, shielded players, or the player themselves.
 *  - Each player's shortlist is drawn independently at random, but BALANCED: candidates that are
 *    already on the fewest other shortlists are preferred, so attention spreads across the arena
 *    instead of everyone seeing the same few players.
 *  - Best effort: no two players get the identical set of options while the arena is big enough
 *    for that to be possible.
 *  - Shortlists are stable: when an option is knocked out / solves, only that slot is refilled.
 *  - With nobody left to attack, a player keeps WATCHING a non-eliminated opponent (in a duel you
 *    keep seeing your shielded opponent) — steals at them are refused by the reducer.
 *
 * Two players → each player's only option is the other one (the classic duel).
 */
export function isStealable(p: PublicPlayer | undefined): boolean {
  return !!p && p.status === 'alive';
}

const setKey = (ids: readonly string[]) => [...ids].sort().join('|');

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * (Re)builds shortlists and chosen targets in place. Valid options and choices are kept.
 * Returns the ids of players whose CHOSEN target changed (for "new target" notifications).
 *
 * @param choices  shortlist size (settings.targetChoices)
 * @param fresh    ignore existing shortlists (match start)
 */
export function assignTargets(players: PublicPlayer[], rng: () => number, choices: number, fresh = false): string[] {
  if (fresh) {
    for (const p of players) {
      delete p.targetOptions;
      delete p.targetId;
    }
  }
  const byId = new Map(players.map((p) => [p.id, p]));
  const stealableIds = new Set(players.filter(isStealable).map((p) => p.id));

  // How many shortlists each player currently appears on (after dropping invalid entries).
  const exposure = new Map<string, number>();
  const keys = new Map<string, string>();
  for (const p of players) {
    p.targetOptions = (p.targetOptions ?? []).filter((id) => id !== p.id && stealableIds.has(id));
    if (p.status === 'eliminated') p.targetOptions = [];
    for (const id of p.targetOptions) exposure.set(id, (exposure.get(id) ?? 0) + 1);
    keys.set(p.id, setKey(p.targetOptions));
  }
  const bump = (id: string, d: number) => exposure.set(id, Math.max(0, (exposure.get(id) ?? 0) + d));
  const duplicates = (p: PublicPlayer, opts: string[]) => {
    const k = setKey(opts);
    return players.some((q) => q.id !== p.id && q.status !== 'eliminated' && keys.get(q.id) === k);
  };

  const changed: string[] = [];
  for (const p of shuffled(players, rng)) {
    const before = p.targetId;
    if (p.status !== 'eliminated') {
      const opts = p.targetOptions ?? [];
      const pool = players.filter((o) => o.id !== p.id && isStealable(o));
      const want = Math.min(choices, pool.length);
      // Fill free slots: least-exposed candidates first, random among equals.
      while (opts.length < want) {
        const candidates = pool.filter((o) => !opts.includes(o.id));
        const min = Math.min(...candidates.map((c) => exposure.get(c.id) ?? 0));
        const least = candidates.filter((c) => (exposure.get(c.id) ?? 0) === min);
        const pick = least[randomInt(rng, least.length)] as PublicPlayer;
        opts.push(pick.id);
        bump(pick.id, 1);
      }
      // Best-effort uniqueness: swap one option until no other player has the very same set.
      for (let attempt = 0; attempt < 8 && opts.length === want && pool.length > want && duplicates(p, opts); attempt++) {
        const slot = randomInt(rng, opts.length);
        const outside = pool.filter((o) => !opts.includes(o.id));
        const replacement = outside[randomInt(rng, outside.length)] as PublicPlayer;
        bump(opts[slot] as string, -1);
        opts[slot] = replacement.id;
        bump(replacement.id, 1);
      }
      p.targetOptions = opts;
      keys.set(p.id, setKey(opts));
    }

    // Chosen target: keep it if still on the shortlist, else take the first option.
    const opts = p.targetOptions ?? [];
    if (!(p.targetId && opts.includes(p.targetId))) {
      if (opts.length) {
        p.targetId = opts[0];
      } else {
        // Nobody stealable: keep watching the current opponent if still standing, else anyone standing.
        const current = p.targetId ? byId.get(p.targetId) : undefined;
        if (!current || current.id === p.id || current.status === 'eliminated') {
          const watchable = players.filter((o) => o.id !== p.id && o.status !== 'eliminated');
          const next = watchable.length ? watchable[randomInt(rng, watchable.length)] : undefined;
          if (next) p.targetId = next.id;
          else delete p.targetId;
        }
      }
    }
    if (p.targetId !== before) changed.push(p.id);
  }
  return changed;
}

/**
 * Whether `stealerId` may aim at `targetId`: it must be on their shortlist (or be the opponent they
 * are watching — status rules such as "shielded" are checked by the reducer).
 */
export function isAssignedTarget(players: readonly PublicPlayer[], stealerId: string, targetId: string): boolean {
  if (stealerId === targetId) return false;
  const stealer = players.find((p) => p.id === stealerId);
  if (!stealer || !players.some((p) => p.id === targetId)) return false;
  return stealer.targetId === targetId || (stealer.targetOptions ?? []).includes(targetId);
}

/** How many players have currently CHOSEN to attack `playerId`. */
export function attackerCount(players: readonly PublicPlayer[], playerId: string): number {
  return players.filter((p) => p.targetId === playerId && p.status !== 'eliminated' && p.id !== playerId).length;
}
