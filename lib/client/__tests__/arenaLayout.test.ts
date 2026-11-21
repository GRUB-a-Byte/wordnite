import { describe, expect, it } from 'vitest';
import { bestGrid, MINI_TILE_MAX, MINI_TILE_MIN } from '../arenaLayout';

describe('bestGrid (spectator arena packing)', () => {
  it('two boards on a wide screen sit side by side', () => {
    expect(bestGrid(2, 1600, 800, 6).cols).toBe(2);
  });

  it('a portrait phone stacks fewer columns than a projector for the same players', () => {
    const phone = bestGrid(12, 380, 700, 6);
    const projector = bestGrid(12, 1900, 900, 6);
    expect(phone.cols).toBeLessThan(projector.cols);
  });

  it('100 boards on a 1080p projector all fit, with readable-ish tiles', () => {
    const { cols, tile } = bestGrid(100, 1900, 860, 6);
    const rows = Math.ceil(100 / cols);
    expect(cols * rows).toBeGreaterThanOrEqual(100);
    expect(tile).toBeGreaterThanOrEqual(8);
  });

  it('more rows per board (overtime) means smaller tiles, never overflow', () => {
    expect(bestGrid(20, 1600, 900, 9).tile).toBeLessThanOrEqual(bestGrid(20, 1600, 900, 6).tile);
  });

  it('tile size is clamped to sane limits', () => {
    expect(bestGrid(1, 5000, 5000, 6).tile).toBe(MINI_TILE_MAX);
    expect(bestGrid(100, 50, 50, 9).tile).toBe(MINI_TILE_MIN);
  });
});
