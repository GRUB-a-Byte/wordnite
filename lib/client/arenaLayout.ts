/**
 * Geometry of the spectator "arena" (components/ArenaGrid.tsx): every player's mini board packed
 * into the grid that gives the largest tiles for the available space. Pure, so it is unit-tested.
 */

/** px between mini boards. */
export const ARENA_GAP = 6;
/** px height of a mini board's header line. */
export const MINI_HEADER = 18;
/** Padding around a mini board's tiles, in tile units (each side). */
export const MINI_PAD = 0.3;
/** Gap between mini tiles, in tile units. */
export const MINI_TILE_GAP = 0.12;
/** Tile size limits (px). */
export const MINI_TILE_MIN = 3;
export const MINI_TILE_MAX = 48;

/** Columns and tile size (px) that fit `n` mini boards of `rows` rows into `w` × `h` px with the largest tiles. */
export function bestGrid(n: number, w: number, h: number, rows: number): { cols: number; tile: number } {
  const wUnits = 5 + MINI_TILE_GAP * 4 + 2 * MINI_PAD;
  const hUnits = rows + MINI_TILE_GAP * (rows - 1) + 2 * MINI_PAD;
  let best = { cols: 1, tile: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const r = Math.ceil(n / cols);
    const tW = (w - (cols - 1) * ARENA_GAP - cols * 2) / (cols * wUnits);
    const tH = (h - (r - 1) * ARENA_GAP - r * (MINI_HEADER + 2)) / (r * hUnits);
    const tile = Math.min(tW, tH);
    if (tile > best.tile) best = { cols, tile };
  }
  return { cols: best.cols, tile: Math.max(MINI_TILE_MIN, Math.min(MINI_TILE_MAX, Math.floor(best.tile))) };
}
