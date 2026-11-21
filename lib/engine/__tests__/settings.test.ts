import { describe, expect, it } from 'vitest';
import { DEBUG_SETTINGS, DEFAULT_SETTINGS, InvalidSettingsError, resolveSettings, settingsProblems } from '../settings';
import { createDictionary, unpackWords } from '@/lib/words';
import { PACKED_ANSWERS } from '@/lib/words/answers';
import { PACKED_VALID } from '@/lib/words/valid';

describe('GameSettings (FIX 3)', () => {
  it('defaults match the SRS', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      wordLength: 5,
      baseRows: 6,
      overtimeExtraRows: 3,
      postSolveStealRows: 3,
      countdownMs: 3000,
      matchMs: 120000,
      overtimeMs: 45000,
      guestGraceMs: 15000,
      hostGraceMs: 10000,
      maxPlayers: 2,
      enableUnbeatableEarlyFinish: true,
    });
    expect(settingsProblems({ ...DEFAULT_SETTINGS })).toEqual([]);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });

  it('debug settings shorten the timers (20 s / 10 s)', () => {
    expect(DEBUG_SETTINGS.matchMs).toBe(20_000);
    expect(DEBUG_SETTINGS.overtimeMs).toBe(10_000);
  });

  it('rejects invalid values', () => {
    expect(() => resolveSettings({ baseRows: 0 })).toThrow(InvalidSettingsError);
    expect(() => resolveSettings({ matchMs: 1.5 })).toThrow(InvalidSettingsError);
    expect(() => resolveSettings({ maxPlayers: 8 })).toThrow(/two players/);
    expect(() => resolveSettings({ wordLength: 6 })).toThrow(/5-letter/);
    expect(() =>
      resolveSettings({ enableUnbeatableEarlyFinish: 'no' as unknown as boolean }),
    ).toThrow(InvalidSettingsError);
  });

  it('merges patches and ignores unknown keys', () => {
    const s = resolveSettings({ matchMs: 60_000, bogus: 1 } as never);
    expect(s.matchMs).toBe(60_000);
    expect(s).not.toHaveProperty('bogus');
  });
});

describe('word lists (SRS §8.7)', () => {
  const answers = unpackWords(PACKED_ANSWERS);
  const valid = unpackWords(PACKED_VALID);

  it('answer list is ~2,000 unique upper-case 5-letter words', () => {
    expect(answers.length).toBeGreaterThan(1800);
    expect(answers.length).toBeLessThan(2500);
    expect(new Set(answers).size).toBe(answers.length);
    for (const w of answers) expect(w).toMatch(/^[A-Z]{5}$/);
  });

  it('valid-guess list is ~10–13k words and contains every answer', () => {
    expect(valid.length).toBeGreaterThan(10_000);
    expect(valid.length).toBeLessThan(13_000);
    const dict = createDictionary(valid, answers);
    for (const w of answers) expect(dict.isValid(w)).toBe(true);
    expect(dict.isValid('crane')).toBe(true);
    expect(dict.isValid('ZZZZZ')).toBe(false);
  });

  it('blocklisted words are never secret answers', () => {
    for (const w of ['BITCH', 'WHORE', 'IDIOT', 'SLAVE']) expect(answers).not.toContain(w);
  });
});
