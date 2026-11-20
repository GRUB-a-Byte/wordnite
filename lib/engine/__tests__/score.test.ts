import { describe, expect, it } from 'vitest';
import { isSolved, scoreGuess } from '../score';

const C = 'correct';
const P = 'present';
const X = 'absent';

describe('scoreGuess (GR-16 two-pass scoring)', () => {
  it('ABBEY / BOBBY → present, absent, correct, absent, correct (SRS example)', () => {
    expect(scoreGuess('BOBBY', 'ABBEY')).toEqual([P, X, C, X, C]);
  });

  it('SPEED vs secret ERASE — duplicate E only marked as often as it occurs', () => {
    // secret ERASE has E×2, S×1. guess SPEED: S present, P absent, E present, E present, D absent.
    expect(scoreGuess('SPEED', 'ERASE')).toEqual([P, X, P, P, X]);
  });

  it('ERASE vs secret SPEED', () => {
    // secret SPEED: S P E E D. guess E R A S E: E present, R absent, A absent, S present, E present
    expect(scoreGuess('ERASE', 'SPEED')).toEqual([P, X, X, P, P]);
  });

  it('all green', () => {
    expect(scoreGuess('CRANE', 'CRANE')).toEqual([C, C, C, C, C]);
    expect(isSolved(scoreGuess('CRANE', 'CRANE'))).toBe(true);
  });

  it('all grey', () => {
    expect(scoreGuess('JUMPY', 'CRANE')).toEqual([X, X, X, X, X]);
    expect(isSolved(scoreGuess('JUMPY', 'CRANE'))).toBe(false);
  });

  it('a correct match consumes the letter before presents are assigned', () => {
    // secret ABBEY, guess KEBAB: K absent, E present, B correct, A present, B present (2nd B left)
    expect(scoreGuess('KEBAB', 'ABBEY')).toEqual([X, P, C, P, P]);
    // secret CRANE, guess EERIE: only one E in secret, and it is matched exactly at index 4.
    expect(scoreGuess('EERIE', 'CRANE')).toEqual([X, X, P, X, C]);
  });

  it('is case-insensitive', () => {
    expect(scoreGuess('crane', 'CRANE')).toEqual([C, C, C, C, C]);
  });

  it('throws on a length mismatch', () => {
    expect(() => scoreGuess('CRAN', 'CRANE')).toThrow();
  });
});
