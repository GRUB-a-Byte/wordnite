import type { PublicGameState, PublicPlayer } from '@/lib/engine/types';

/** Whether this board shows the post-solve ammo tray. */
export function hasAmmoTray(p: PublicPlayer): boolean {
  return p.status === 'invulnerable' || p.solvedInRows !== undefined || p.rows.some((r) => !r.scoring);
}

/**
 * Inputs for the CSS fit system in globals.css (.fit-row). Both boards share ONE tile size, sized
 * for the tallest board, so they always line up. Rows are counted in "tile units": a row is one
 * tile plus a 0.1-tile gap.
 */
export function fitVars(game: PublicGameState): React.CSSProperties {
  const units = (n: number) => (n > 0 ? n + 0.1 * (n - 1) : 0);
  let rowsU = units(game.settings.baseRows);
  let tray = false;
  for (const p of game.players) {
    const t = hasAmmoTray(p);
    tray ||= t;
    rowsU = Math.max(rowsU, units(p.rowLimit) + (t ? units(game.settings.postSolveStealRows) : 0));
  }
  return { '--rows-u': rowsU.toFixed(2), '--has-tray': tray ? 1 : 0 } as React.CSSProperties;
}
