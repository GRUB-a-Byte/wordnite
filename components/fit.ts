import type { PublicGameState } from '@/lib/engine/types';

/**
 * Sizes tiles so the TALLEST board (base rows, +3 in overtime, + ammo tray once solved) fits the
 * viewport above the keyboard. Both boards use the same row count so they stay visually aligned.
 * `chromeVar` is the CSS variable holding the non-board vertical space (see globals.css).
 */
export function fitStyle(game: PublicGameState, chromeVar: '--chrome' | '--chrome-spectator'): React.CSSProperties {
  const rows = Math.max(
    game.settings.baseRows,
    ...game.players.map((p) => {
      const tray = p.status === 'invulnerable' || p.solvedInRows !== undefined || p.rows.some((r) => !r.scoring);
      return p.rowLimit + (tray ? game.settings.postSolveStealRows + 1.2 : 0) + (p.solvedInRows !== undefined ? 0.7 : 0);
    }),
  );
  // One row ≈ one tile + gap ≈ 1.12 tiles.
  return { '--fit': `calc((100dvh - var(${chromeVar})) / ${(rows * 1.12).toFixed(2)})` } as React.CSSProperties;
}
