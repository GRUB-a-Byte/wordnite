/**
 * Row ids whose tile-flip reveal has already played in this tab. Rows present in the very first
 * snapshot after (re)joining are marked up-front so a reconnect does not replay every flip.
 */
const revealed = new Set<string>();

export function hasRevealed(rowId: string): boolean {
  return revealed.has(rowId);
}

export function markRevealed(rowIds: Iterable<string>): void {
  for (const id of rowIds) revealed.add(id);
}
