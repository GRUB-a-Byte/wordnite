import type { GameSettings } from './types';

/**
 * Central defaults (FIX 3). Every rule constant lives here — nothing else in the codebase may
 * hard-code these numbers (NFR-12).
 */
export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  wordLength: 5,
  baseRows: 6,
  overtimeExtraRows: 3,
  postSolveStealRows: 3,
  countdownMs: 3_000,
  matchMs: 120_000,
  overtimeMs: 45_000,
  guestGraceMs: 15_000,
  hostGraceMs: 10_000,
  maxPlayers: 2,
  enableUnbeatableEarlyFinish: true,
});

/** `?debug=1` settings (SRS §11.3): 20 s match / 10 s overtime for dry runs. */
export const DEBUG_SETTINGS: Readonly<GameSettings> = Object.freeze({
  ...DEFAULT_SETTINGS,
  matchMs: 20_000,
  overtimeMs: 10_000,
});

interface IntRule {
  min: number;
  max: number;
  why?: string;
}

const INT_RULES: Record<Exclude<keyof GameSettings, 'enableUnbeatableEarlyFinish'>, IntRule> = {
  // Only five-letter word lists ship with 1.0.
  wordLength: { min: 5, max: 5, why: 'only 5-letter word lists are bundled' },
  baseRows: { min: 1, max: 12 },
  overtimeExtraRows: { min: 0, max: 6 },
  postSolveStealRows: { min: 0, max: 6 },
  countdownMs: { min: 0, max: 10_000 },
  matchMs: { min: 5_000, max: 30 * 60_000 },
  overtimeMs: { min: 5_000, max: 10 * 60_000 },
  guestGraceMs: { min: 1_000, max: 120_000 },
  hostGraceMs: { min: 1_000, max: 120_000 },
  // Release 1.0 is a 2-player duel. The engine is written over player arrays so this can grow later.
  maxPlayers: { min: 2, max: 2, why: 'release 1.0 supports exactly two players' },
};

export class InvalidSettingsError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid game settings: ${problems.join('; ')}`);
    this.name = 'InvalidSettingsError';
  }
}

/** Returns a list of problems (empty when valid). */
export function settingsProblems(s: GameSettings): string[] {
  const problems: string[] = [];
  for (const [key, rule] of Object.entries(INT_RULES) as [keyof typeof INT_RULES, IntRule][]) {
    const v = s[key];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      problems.push(`${key} must be an integer`);
    } else if (v < rule.min || v > rule.max) {
      problems.push(`${key} must be between ${rule.min} and ${rule.max}${rule.why ? ` (${rule.why})` : ''}`);
    }
  }
  if (typeof s.enableUnbeatableEarlyFinish !== 'boolean') {
    problems.push('enableUnbeatableEarlyFinish must be a boolean');
  }
  return problems;
}

export function validateSettings(s: GameSettings): GameSettings {
  const problems = settingsProblems(s);
  if (problems.length) throw new InvalidSettingsError(problems);
  return s;
}

/** Merges a partial patch over a base (defaults by default) and validates the result. */
export function resolveSettings(
  patch: Partial<GameSettings> = {},
  base: Readonly<GameSettings> = DEFAULT_SETTINGS,
): GameSettings {
  const merged: GameSettings = { ...base };
  for (const key of Object.keys(patch) as (keyof GameSettings)[]) {
    if (!(key in DEFAULT_SETTINGS)) continue; // ignore unknown keys from the wire
    const value = patch[key];
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return validateSettings(merged);
}
