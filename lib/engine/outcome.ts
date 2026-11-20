import type { GameResult, GameSettings, PublicPlayer } from './types';

/**
 * Win-condition evaluation (GR-26 … GR-29, GR-30, GR-33). Pure functions over the player array.
 * The reducer decides WHEN to call these; this module only decides WHO wins and WHY.
 */

/** Best solver first: fewer rows, then earlier authoritative solve time, then processing order. */
export function rankSolvers<P extends PublicPlayer>(solvers: readonly P[]): P[] {
  return [...solvers].sort(
    (a, b) =>
      (a.solvedInRows ?? Infinity) - (b.solvedInRows ?? Infinity) ||
      (a.solvedAt ?? Infinity) - (b.solvedAt ?? Infinity) ||
      (a.solveOrder ?? Infinity) - (b.solveOrder ?? Infinity),
  );
}

export interface EvaluateOptions {
  /** Whether GR-28 may be applied in this pass (also gated by settings.enableUnbeatableEarlyFinish). */
  includeUnbeatable: boolean;
}

/**
 * Returns the match result if the current statuses already decide the match, otherwise null.
 *
 * Order (SRS §3.9): GR-26 last standing → GR-27 both solved → GR-28 unbeatable → GR-29 no winner.
 * GR-29 is checked first in code because "nobody standing" short-circuits everything else.
 */
export function evaluateOutcome(
  players: readonly PublicPlayer[],
  settings: GameSettings,
  opts: EvaluateOptions,
): GameResult | null {
  const standing = players.filter((p) => p.status !== 'eliminated');

  // GR-29: everyone eliminated in the same transition → draw.
  if (standing.length === 0) return { outcome: 'draw', reason: 'all_eliminated' };

  // GR-26: last standing.
  if (standing.length === 1) {
    const winner = standing[0] as PublicPlayer;
    const decisive = [...players]
      .filter((p) => p.status === 'eliminated')
      .sort((a, b) => (b.eliminatedAt ?? 0) - (a.eliminatedAt ?? 0))[0];
    const reason =
      decisive?.eliminationReason === 'stolen'
        ? 'stolen'
        : decisive?.eliminationReason === 'forfeit'
          ? 'forfeit'
          : 'opponent_out_of_rows';
    return { outcome: 'win', winnerId: winner.id, loserId: decisive?.id, reason };
  }

  const alive = standing.filter((p) => p.status === 'alive');
  const solvers = standing.filter((p) => p.status === 'invulnerable');

  // GR-27: everyone still standing has solved → fewer rows wins, tie → earlier solve.
  if (alive.length === 0 && solvers.length >= 2) {
    const [first, second] = rankSolvers(solvers) as [PublicPlayer, PublicPlayer];
    const reason = (first.solvedInRows ?? 0) < (second.solvedInRows ?? 0) ? 'fewer_rows' : 'same_rows_earlier';
    return { outcome: 'win', winnerId: first.id, loserId: second.id, reason };
  }

  // GR-28: a solver is mathematically unbeatable — every unsolved player's best possible solve
  // would land on >= the solver's row count (and lose the time tie-break).
  if (opts.includeUnbeatable && settings.enableUnbeatableEarlyFinish && solvers.length > 0 && alive.length > 0) {
    const best = rankSolvers(solvers)[0] as PublicPlayer;
    const rA = best.solvedInRows ?? 0;
    if (alive.every((p) => p.rowsUsed >= rA - 1)) {
      return { outcome: 'win', winnerId: best.id, loserId: alive[0]?.id, reason: 'unbeatable' };
    }
  }

  return null;
}

/**
 * GR-30 / GR-33: what happens when the match or overtime clock runs out.
 *  - at least one solver → best solver wins ("timeout_solver")
 *  - nobody solved, overtime still available → 'overtime'
 *  - nobody solved, overtime already used → draw ("overtime_expired", everybody loses)
 */
export function timeoutOutcome(
  players: readonly PublicPlayer[],
  overtimeAvailable: boolean,
): { kind: 'result'; result: GameResult } | { kind: 'overtime' } {
  const standing = players.filter((p) => p.status !== 'eliminated');
  const solvers = standing.filter((p) => p.status === 'invulnerable');
  if (solvers.length > 0) {
    const ranked = rankSolvers(solvers);
    const winner = ranked[0] as PublicPlayer;
    const loser = standing.find((p) => p.id !== winner.id);
    return { kind: 'result', result: { outcome: 'win', winnerId: winner.id, loserId: loser?.id, reason: 'timeout_solver' } };
  }
  if (overtimeAvailable) return { kind: 'overtime' };
  return { kind: 'result', result: { outcome: 'draw', reason: 'overtime_expired' } };
}
