import type { PublicPlayer, Row, TileState } from '@/lib/engine/types';

const RANK: Record<TileState, number> = { absent: 0, present: 1, correct: 2 };

/** Best known state per letter: correct > present > absent (FR-3.5). */
export function keyStates(rows: readonly Row[]): Record<string, TileState> {
  const out: Record<string, TileState> = {};
  for (const row of rows) {
    row.tiles.forEach((t, i) => {
      const ch = row.word[i];
      if (!ch) return;
      const prev = out[ch];
      if (prev === undefined || RANK[t] > RANK[prev]) out[ch] = t;
    });
  }
  return out;
}

/**
 * Every PUBLIC row that was scored against `target`'s secret word — the information available
 * about the word you are currently attacking (FR-3.5):
 *  - own mode  (target = me):       my own guesses + any opponent steal rows aimed at me
 *  - steal mode (target = opponent): the opponent's own guesses + my steal rows against them
 */
export function rowsScoredAgainst(target: PublicPlayer, everyone: readonly PublicPlayer[]): Row[] {
  const rows: Row[] = [];
  for (const p of everyone) {
    for (const r of p.rows) if (r.targetId === target.id) rows.push(r);
  }
  return rows;
}
