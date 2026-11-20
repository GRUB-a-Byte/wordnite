import type { TileState } from './types';

/**
 * GR-16 two-pass scoring, correct for duplicate letters.
 *  Pass 1: exact matches are `correct` and consume that secret letter.
 *  Pass 2: remaining guess letters are `present` if an UNCONSUMED copy exists in the secret
 *          (consuming one occurrence), otherwise `absent`.
 *
 * Example: secret ABBEY, guess BOBBY → present, absent, correct, absent, correct.
 */
export function scoreGuess(guess: string, secret: string): TileState[] {
  if (guess.length !== secret.length) {
    throw new Error(`scoreGuess: length mismatch (${guess.length} vs ${secret.length})`);
  }
  const g = guess.toUpperCase();
  const s = secret.toUpperCase();
  const tiles: TileState[] = new Array<TileState>(g.length).fill('absent');
  const remaining = new Map<string, number>();

  for (let i = 0; i < g.length; i++) {
    if (g[i] === s[i]) {
      tiles[i] = 'correct';
    } else {
      const ch = s[i] as string;
      remaining.set(ch, (remaining.get(ch) ?? 0) + 1);
    }
  }
  for (let i = 0; i < g.length; i++) {
    if (tiles[i] === 'correct') continue;
    const ch = g[i] as string;
    const left = remaining.get(ch) ?? 0;
    if (left > 0) {
      tiles[i] = 'present';
      remaining.set(ch, left - 1);
    }
  }
  return tiles;
}

export function isSolved(tiles: readonly TileState[]): boolean {
  return tiles.every((t) => t === 'correct');
}
