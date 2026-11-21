import { describe, expect, it } from 'vitest';
import { evaluateOutcome } from '../outcome';
import { createRng } from '../rng';
import { reduce } from '../reducer';
import { pickSecrets } from '../secrets';
import { createLobbyState } from '../state';
import { DEFAULT_SETTINGS } from '../settings';
import { createDictionary, unpackWords } from '@/lib/words';
import { PACKED_ANSWERS } from '@/lib/words/answers';
import { PACKED_VALID } from '@/lib/words/valid';
import { A, B, Sim } from './helpers';

// Secrets in every Sim unless overridden: A = CRANE, B = SLATE.

describe('setup (GR-1 … GR-5)', () => {
  it('GR-2: secrets for 2 players are distinct across 10k seeded runs (real answer list)', () => {
    const answers = unpackWords(PACKED_ANSWERS);
    for (let seed = 1; seed <= 10_000; seed++) {
      const [a, b] = pickSecrets(answers, 2, createRng(seed));
      expect(a).not.toBe(b);
    }
  });

  it('GR-3/GR-4: START assigns secrets, resets players and enters a countdown', () => {
    const sim = new Sim();
    sim.client({ type: 'START', playerId: A });
    expect(sim.state.phase).toBe('COUNTDOWN');
    expect(sim.state.phaseEndsAt).toBe(sim.now + DEFAULT_SETTINGS.countdownMs);
    for (const p of sim.state.players) {
      expect(p).toMatchObject({ status: 'alive', rowsUsed: 0, rowLimit: 6, postSolveStealRows: 0 });
    }
    expect(sim.p(A).secret).toBe('CRANE');
    expect(sim.p(B).secret).toBe('SLATE');
    expect(sim.p(A).targetId).toBe(B);
    expect(sim.p(B).targetId).toBe(A);
  });

  it('GR-4: actions during the countdown are rejected; GR-5: the 2:00 clock starts at countdown end', () => {
    const sim = new Sim();
    sim.client({ type: 'START', playerId: A });
    const res = sim.guess(A, 'TRAIN');
    expect(res.rejections[0]?.reason).toBe('not_playing');
    const countdownEnd = sim.state.phaseEndsAt as number;
    sim.advance(DEFAULT_SETTINGS.countdownMs + 100); // TICK arrives 100ms late
    expect(sim.state.phase).toBe('PLAYING');
    expect(sim.state.playStartedAt).toBe(countdownEnd);
    expect(sim.state.phaseEndsAt).toBe(countdownEnd + DEFAULT_SETTINGS.matchMs);
  });

  it('START: host only, and only with exactly 2 connected players', () => {
    const sim = new Sim();
    expect(sim.client({ type: 'START', playerId: B }).rejections[0]?.reason).toBe('not_host');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: B });
    expect(sim.client({ type: 'START', playerId: A }).rejections[0]?.reason).toBe('not_enough_players');
    expect(sim.state.phase).toBe('LOBBY');
  });
});

describe('validation (GR-11 … GR-15)', () => {
  it('GR-11/GR-12: malformed or unknown words are rejected and use no row', () => {
    const sim = new Sim().startPlaying();
    for (const w of ['ZZZZZ', 'CRAN', 'CRANES', 'CR4NE', '']) {
      const res = sim.guess(A, w);
      expect(res.rejections[0]?.reason).toBe('invalid_word');
    }
    expect(sim.p(A).rowsUsed).toBe(0);
    expect(sim.p(A).rows).toHaveLength(0);
  });

  it('GR-11: lower-case input is accepted and stored upper-case', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'train');
    expect(sim.p(A).rows[0]?.word).toBe('TRAIN');
  });

  it('GR-13: duplicate word against the same target is rejected; same word vs a different target is fine', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'TRAIN');
    const dup = sim.guess(A, 'TRAIN');
    expect(dup.rejections[0]?.reason).toBe('duplicate');
    expect(sim.p(A).rowsUsed).toBe(1);
    const steal = sim.steal(A, 'TRAIN');
    expect(steal.rejections).toHaveLength(0);
    expect(sim.p(A).rowsUsed).toBe(2);
    expect(sim.steal(A, 'TRAIN').rejections[0]?.reason).toBe('duplicate');
    expect(sim.p(A).rowsUsed).toBe(2);
  });

  it('GR-15: an alive player at the row limit cannot submit (defensive check)', () => {
    const sim = new Sim().startPlaying();
    // GR-25 normally eliminates first, so force the inconsistent state directly.
    sim.state.players[0]!.rowsUsed = sim.state.players[0]!.rowLimit;
    expect(sim.guess(A, 'TRAIN').rejections[0]?.reason).toBe('no_rows');
    expect(sim.steal(A, 'TRAIN').rejections[0]?.reason).toBe('no_rows');
    expect(sim.p(A).rows).toHaveLength(0);
  });

  it('GR-14: actions from non-players are rejected', () => {
    const sim = new Sim().startPlaying();
    const res = sim.dispatch({ type: 'GUESS', playerId: 'stranger', word: 'TRAIN', clientSeq: 1 });
    expect(res.rejections[0]?.reason).toBe('not_a_player');
    expect(res.changed).toBe(false);
  });
});

describe('own guesses (GR-17 … GR-19)', () => {
  it('GR-17: an own guess uses one row and is appended as kind "own"', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'TRAIN');
    expect(sim.p(A).rowsUsed).toBe(1);
    expect(sim.p(A).rows[0]).toMatchObject({ word: 'TRAIN', kind: 'own', targetId: A, scoring: true, hit: false });
    expect(sim.p(A).rows[0]?.tiles).toEqual(['absent', 'correct', 'correct', 'absent', 'present']);
  });

  it('GR-18: solving → invulnerable, solvedInRows locked, 3 post-solve steal rows', () => {
    const s2 = new Sim().startPlaying();
    s2.guess(A, 'TRAIN');
    s2.guess(A, 'GHOST');
    const res = s2.guess(A, 'CRANE');
    const a = s2.p(A);
    expect(a.status).toBe('invulnerable');
    expect(a.solvedInRows).toBe(3);
    expect(a.solvedAt).toBe(s2.now);
    expect(a.postSolveStealRows).toBe(3);
    expect(res.events.map((e) => e.type)).toContain('SOLVED');
    expect(s2.state.phase).toBe('PLAYING'); // B has 0 rows < 3 − 1 → can still win
  });

  it('GR-19: an invulnerable player can no longer submit own guesses', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'TRAIN');
    sim.guess(A, 'CRANE');
    const res = sim.guess(A, 'GHOST');
    expect(res.rejections[0]?.reason).toBe('already_solved');
    expect(sim.p(A).rowsUsed).toBe(2);
  });
});

describe('steals (GR-20 … GR-24)', () => {
  it('GR-21: a pre-solve steal uses a scoring row and counts toward solvedInRows', () => {
    const sim = new Sim().startPlaying();
    sim.steal(A, 'TRAIN'); // vs SLATE
    expect(sim.p(A).rowsUsed).toBe(1);
    expect(sim.p(A).rows[0]).toMatchObject({ kind: 'steal', targetId: B, scoring: true, hit: false });
    expect(sim.p(A).rows[0]?.tiles).toEqual(['present', 'absent', 'correct', 'absent', 'absent']);
    sim.guess(A, 'GHOST');
    sim.guess(A, 'CRANE');
    expect(sim.p(A).solvedInRows).toBe(3);
  });

  it('GR-21 / E-6: post-solve steals use ammo only; the 4th is rejected', () => {
    const sim = new Sim().startPlaying();
    sim.guess(B, 'TRAIN');
    sim.guess(A, 'GHOST');
    sim.guess(A, 'PLUMB');
    sim.guess(A, 'CRANE'); // A solves in 3, B has 1 row (< 2) → play on
    expect(sim.state.phase).toBe('PLAYING');
    expect(sim.steal(A, 'MOUND').rejections).toHaveLength(0);
    expect(sim.steal(A, 'PIOUS').rejections).toHaveLength(0);
    expect(sim.p(A).postSolveStealRows).toBe(1);
    expect(sim.p(A).rowsUsed).toBe(3);
    expect(sim.p(A).solvedInRows).toBe(3);
    expect(sim.p(A).rows.slice(-2).every((r) => !r.scoring)).toBe(true);
    expect(sim.state.phase).toBe('PLAYING'); // B at 1 row < 3 − 1
    sim.steal(A, 'FJORD');
    expect(sim.p(A).postSolveStealRows).toBe(0);
    const res = sim.steal(A, 'WALTZ');
    expect(res.rejections[0]?.reason).toBe('no_ammo');
    expect(sim.p(A).status).toBe('invulnerable'); // disarmed but still shielded
  });

  it('GR-20 / E-2: stealing from an invulnerable target is rejected and uses no row', () => {
    const sim = new Sim().startPlaying();
    sim.guess(B, 'TRAIN');
    sim.guess(A, 'GHOST');
    sim.guess(A, 'PLUMB');
    sim.guess(A, 'CRANE'); // A shielded
    const res = sim.steal(B, 'CRANE');
    expect(res.rejections[0]?.reason).toBe('target_shielded');
    expect(sim.p(B).rowsUsed).toBe(1);
    expect(sim.p(A).status).toBe('invulnerable');
  });

  it('GR-23 / GR-26: a successful steal eliminates the target and the stealer wins', () => {
    const sim = new Sim().startPlaying();
    const res = sim.steal(A, 'SLATE');
    expect(sim.p(B)).toMatchObject({ status: 'eliminated', eliminationReason: 'stolen', eliminatedBy: A });
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.state.result).toEqual({ outcome: 'win', winnerId: A, loserId: B, reason: 'stolen' });
    expect(res.events.map((e) => e.type)).toEqual(['ROW_ADDED', 'STEAL_HIT', 'ELIMINATED', 'FINISHED']);
  });

  it('GR-24 / E-20: typing your own secret as a steal does not solve your own word', () => {
    const sim = new Sim().startPlaying();
    sim.steal(A, 'CRANE'); // A's own secret, scored against B's SLATE
    expect(sim.p(A).status).toBe('alive');
    expect(sim.p(A).rows[0]?.tiles).toEqual(['absent', 'absent', 'correct', 'absent', 'correct']);
    expect(sim.p(B).status).toBe('alive');
  });

  it('a player cannot target themselves or a non-assigned id', () => {
    const sim = new Sim().startPlaying();
    expect(sim.steal(A, 'TRAIN', A).rejections[0]?.reason).toBe('invalid_target');
    expect(sim.steal(A, 'TRAIN', 'ghost-id').rejections[0]?.reason).toBe('invalid_target');
    expect(sim.p(A).rowsUsed).toBe(0);
  });
});

describe('running out of rows (GR-25, E-4, E-5)', () => {
  it('GR-25: using the last row without solving eliminates; the opponent wins', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 6);
    expect(sim.p(A)).toMatchObject({ status: 'eliminated', eliminationReason: 'out_of_rows' });
    expect(sim.state.result).toMatchObject({ outcome: 'win', winnerId: B, reason: 'opponent_out_of_rows' });
  });

  it('E-4: a successful steal on the final row wins (not an out-of-rows loss)', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 5);
    sim.steal(A, 'SLATE');
    expect(sim.p(A).status).toBe('alive');
    expect(sim.p(A).rowsUsed).toBe(6);
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'stolen' });
  });

  it('E-5: a failed steal on the final row eliminates the stealer', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 5);
    sim.steal(A, 'MOUND');
    expect(sim.p(A)).toMatchObject({ status: 'eliminated', eliminationReason: 'out_of_rows' });
    expect(sim.state.result).toMatchObject({ winnerId: B, reason: 'opponent_out_of_rows' });
  });

  it('solving on the final row is a solve, not an elimination', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.burn(A, 5);
    sim.guess(A, 'CRANE');
    expect(sim.p(A).status).toBe('invulnerable');
    expect(sim.p(A).solvedInRows).toBe(6);
  });
});

describe('both solved (GR-27, E-8)', () => {
  it('fewer rows wins even when solved later (E-8)', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.burn(A, 3);
    sim.guess(A, 'CRANE'); // A solves in 4
    sim.now += 5_000;
    sim.burn(B, 2);
    sim.guess(B, 'SLATE'); // B solves in 3, later in time
    expect(sim.state.result).toMatchObject({ outcome: 'win', winnerId: B, loserId: A, reason: 'fewer_rows' });
  });

  it('equal rows → earlier authoritative solve time wins', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.burn(A, 2);
    sim.burn(B, 2);
    sim.guess(B, 'SLATE'); // B solves in 3 first
    sim.now += 1_000;
    sim.guess(A, 'CRANE'); // A solves in 3 later
    expect(sim.state.result).toMatchObject({ winnerId: B, reason: 'same_rows_earlier' });
  });

  it('equal rows in the same millisecond → host processing order decides', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.burn(A, 1);
    sim.burn(B, 1);
    sim.guess(A, 'CRANE');
    sim.guess(B, 'SLATE'); // same sim.now
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'same_rows_earlier' });
  });
});

describe('unbeatable early finish (GR-28, E-7) — FIX 5', () => {
  it('E-7: A solves in 4, B at 2 rows → play continues; B burns row 3 → A wins "unbeatable"', () => {
    const sim = new Sim().startPlaying();
    sim.burn(B, 2);
    sim.burn(A, 3);
    sim.guess(A, 'CRANE'); // solvedInRows 4, B rowsUsed 2 < 3
    expect(sim.state.phase).toBe('PLAYING');
    sim.burn(B, 1); // B at 3 ≥ 4 − 1
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.state.result).toEqual({ outcome: 'win', winnerId: A, loserId: B, reason: 'unbeatable' });
    // The loser was NOT eliminated by a steal (UI must not claim so).
    expect(sim.p(B).status).toBe('alive');
    expect(sim.state.lastEvents.some((e) => e.type === 'ELIMINATED' || e.type === 'STEAL_HIT')).toBe(false);
  });

  it('B can still win by solving in fewer rows before becoming unbeatable', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 3);
    sim.guess(A, 'CRANE'); // 4 rows
    sim.burn(B, 2);
    sim.guess(B, 'SLATE'); // B solves in 3 < 4
    expect(sim.state.result).toMatchObject({ winnerId: B, reason: 'fewer_rows' });
  });

  it('solving on row 1 wins instantly', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'CRANE');
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'unbeatable' });
  });

  it('solving while the opponent already has rA − 1 rows ends the match immediately', () => {
    const sim = new Sim().startPlaying();
    sim.burn(B, 3);
    sim.burn(A, 3);
    sim.guess(A, 'CRANE'); // rA = 4, B at 3
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'unbeatable' });
  });

  describe('with enableUnbeatableEarlyFinish = false', () => {
    it('solving on row 1 does NOT end the match', () => {
      const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
      sim.guess(A, 'CRANE');
      expect(sim.state.phase).toBe('PLAYING');
      expect(sim.state.result).toBeUndefined();
    });

    it('the remaining player plays on; solving on a higher row count loses on rows', () => {
      const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
      sim.burn(A, 1);
      sim.guess(A, 'CRANE'); // 2 rows
      sim.burn(B, 3);
      expect(sim.state.phase).toBe('PLAYING'); // no premature victory
      sim.guess(B, 'SLATE'); // 4 rows
      expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'fewer_rows' });
    });

    it('the remaining player running out of rows → solver wins with reason opponent_out_of_rows', () => {
      const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
      sim.guess(A, 'CRANE');
      sim.burn(B, 5);
      expect(sim.state.phase).toBe('PLAYING');
      sim.burn(B, 1);
      expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'opponent_out_of_rows' });
    });

    it('the solver can still steal the unsolved player (post-solve ammo)', () => {
      const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
      sim.guess(A, 'CRANE');
      sim.steal(A, 'SLATE');
      expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'stolen' });
    });

    it('timeout with one solver → solver wins', () => {
      const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
      sim.guess(A, 'CRANE');
      sim.advance(DEFAULT_SETTINGS.matchMs);
      expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'timeout_solver' });
    });
  });
});

describe('no winner possible (GR-29)', () => {
  it('everyone eliminated in the same transition → draw', () => {
    const sim = new Sim().startPlaying();
    const players = sim.state.players.map((p) => ({ ...p, status: 'eliminated' as const, eliminationReason: 'forfeit' as const }));
    expect(evaluateOutcome(players, sim.state.settings, { includeUnbeatable: true })).toEqual({
      outcome: 'draw',
      reason: 'all_eliminated',
    });
  });
});

describe('timers and overtime (GR-30 … GR-34, E-19)', () => {
  it('GR-30: timeout with exactly one solver → solver wins', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 2);
    sim.guess(A, 'CRANE'); // rA = 3, B at 0 → still playing
    sim.advance(DEFAULT_SETTINGS.matchMs);
    expect(sim.state.result).toMatchObject({ outcome: 'win', winnerId: A, reason: 'timeout_solver' });
    expect(sim.state.finishedAt).toBe(sim.state.playStartedAt! + DEFAULT_SETTINGS.matchMs);
  });

  it('GR-31: timeout with nobody solved → OVERTIME, +3 rows each, 45 s, overtime only once (GR-34)', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 2);
    const matchEnd = sim.state.phaseEndsAt as number;
    const res = sim.advance(DEFAULT_SETTINGS.matchMs);
    expect(sim.state.phase).toBe('OVERTIME');
    expect(sim.state.overtimeUsed).toBe(true);
    expect(sim.state.phaseEndsAt).toBe(matchEnd + DEFAULT_SETTINGS.overtimeMs);
    expect(sim.p(A).rowLimit).toBe(9);
    expect(sim.p(B).rowLimit).toBe(9);
    expect(sim.p(A).rowsUsed).toBe(2); // A-8: rows are added on top of what was left
    expect(res.events.map((e) => e.type)).toContain('OVERTIME_START');
    sim.advance(DEFAULT_SETTINGS.overtimeMs);
    expect(sim.state.phase).toBe('FINISHED'); // never a second overtime
  });

  it('GR-33: overtime timeout with nobody solved → draw', () => {
    const sim = new Sim().startPlaying();
    sim.advance(DEFAULT_SETTINGS.matchMs);
    sim.advance(DEFAULT_SETTINGS.overtimeMs);
    expect(sim.state.result).toEqual({ outcome: 'draw', reason: 'overtime_expired' });
  });

  it('GR-33: overtime timeout with one solver → solver wins', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.advance(DEFAULT_SETTINGS.matchMs);
    sim.guess(B, 'SLATE');
    sim.advance(DEFAULT_SETTINGS.overtimeMs);
    expect(sim.state.result).toMatchObject({ winnerId: B, reason: 'timeout_solver' });
  });

  it('GR-32 / E-19: running out of rows in overtime eliminates; the other player wins', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 5);
    sim.burn(B, 5);
    sim.advance(DEFAULT_SETTINGS.matchMs);
    expect(sim.state.phase).toBe('OVERTIME');
    sim.burn(A, 3); // 8 rows
    sim.burn(B, 3); // 8 rows
    sim.burn(A, 1); // 9 = limit → out
    expect(sim.state.result).toMatchObject({ winnerId: B, reason: 'opponent_out_of_rows' });
  });

  it('GR-32: unbeatable rule still applies in overtime', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 5);
    sim.burn(B, 5);
    sim.advance(DEFAULT_SETTINGS.matchMs);
    sim.guess(A, 'CRANE'); // rA = 6, B at 5 ≥ 5
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'unbeatable' });
  });
});

describe('conflict resolution & ordering (SRS §5, FIX 6)', () => {
  it('E-1: two simultaneous successful steals → first processed wins, second rejected', () => {
    const sim = new Sim().startPlaying();
    sim.steal(B, 'CRANE');
    const second = sim.steal(A, 'SLATE');
    expect(sim.state.result).toMatchObject({ winnerId: B, reason: 'stolen' });
    expect(second.rejections[0]?.reason).toBe('not_playing');
    expect(sim.p(A).rows).toHaveLength(0);
  });

  it('E-2: A solves, then B’s steal arrives → rejected, B uses no row', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.guess(A, 'CRANE');
    const res = sim.steal(B, 'CRANE');
    expect(res.rejections[0]?.reason).toBe('target_shielded');
    expect(sim.p(B).rowsUsed).toBe(0);
  });

  it('E-3: B’s steal arrives just before A’s solving guess → B wins, A’s guess rejected', () => {
    const sim = new Sim().startPlaying();
    sim.steal(B, 'CRANE');
    const res = sim.guess(A, 'CRANE');
    expect(sim.state.result).toMatchObject({ winnerId: B, reason: 'stolen' });
    expect(res.rejections[0]?.reason).toBe('not_playing');
  });

  it('E-10: any action after FINISHED is rejected', () => {
    const sim = new Sim().startPlaying();
    sim.steal(A, 'SLATE');
    expect(sim.guess(B, 'TRAIN').rejections[0]?.reason).toBe('not_playing');
    expect(sim.steal(B, 'CRANE').rejections[0]?.reason).toBe('not_playing');
  });

  it('FIX 6: a guess arriving after the match deadline is applied AFTER the timeout (no tick-gap exploit)', () => {
    const sim = new Sim().startPlaying();
    sim.burn(A, 2);
    sim.guess(A, 'CRANE'); // A solved in 3, B at 0 → play continues
    sim.now = (sim.state.phaseEndsAt as number) + 100; // no TICK has run yet
    const res = sim.guess(B, 'SLATE'); // would beat A on rows (1 < 3) if accepted
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'timeout_solver' });
    expect(res.rejections[0]?.reason).toBe('not_playing');
    expect(sim.state.finishedAt).toBe(sim.state.playStartedAt! + DEFAULT_SETTINGS.matchMs);
  });

  it('FIX 6: a guess arriving after the match deadline with nobody solved lands in overtime', () => {
    const sim = new Sim().startPlaying();
    sim.now = (sim.state.phaseEndsAt as number) + 50;
    const res = sim.guess(A, 'TRAIN');
    expect(res.rejections).toHaveLength(0);
    expect(sim.state.phase).toBe('OVERTIME');
    expect(sim.p(A).rowLimit).toBe(9);
  });

  it('FIX 6: duplicate / replayed sequence numbers are rejected without side effects', () => {
    const sim = new Sim().startPlaying();
    const first = sim.dispatch({ type: 'GUESS', playerId: A, word: 'TRAIN', clientSeq: 10 });
    expect(first.rejections).toHaveLength(0);
    const replay = sim.dispatch({ type: 'GUESS', playerId: A, word: 'GHOST', clientSeq: 10 });
    expect(replay.rejections[0]?.reason).toBe('duplicate_seq');
    expect(replay.changed).toBe(false);
    const older = sim.dispatch({ type: 'GUESS', playerId: A, word: 'GHOST', clientSeq: 3 });
    expect(older.rejections[0]?.reason).toBe('duplicate_seq');
    expect(sim.p(A).rowsUsed).toBe(1);
    expect(sim.p(A).lastSeq).toBe(10);
  });

  it('FIX 6: rejected actions still advance the ack (lastSeq) so the client can clear its pending row', () => {
    const sim = new Sim().startPlaying(); // START used A's seq 1
    const res = sim.dispatch({ type: 'GUESS', playerId: A, word: 'ZZZZZ', clientSeq: 2 });
    expect(res.rejections[0]?.reason).toBe('invalid_word');
    expect(res.changed).toBe(true);
    expect(sim.p(A).lastSeq).toBe(2);
    expect(sim.p(A).rowsUsed).toBe(0);
  });

  it('no double elimination / double victory: a finished match ignores later timeouts', () => {
    const sim = new Sim().startPlaying();
    sim.steal(A, 'SLATE');
    const resultBefore = sim.state.result;
    const r = sim.advance(DEFAULT_SETTINGS.matchMs * 2);
    expect(r.changed).toBe(false);
    expect(sim.state.result).toEqual(resultBefore);
    expect(sim.state.lastEvents.filter((e) => e.type === 'FINISHED')).toHaveLength(1);
  });

  it('NFR-8: same action sequence + clock + seed → identical state', () => {
    const run = () => {
      const answers = unpackWords(PACKED_ANSWERS);
      const dictionary = createDictionary(unpackWords(PACKED_VALID), answers);
      const rng = createRng(42);
      let s = createLobbyState({ roomCode: 'DTRM', hostId: A, hostNickname: 'a' });
      const step = (action: Parameters<typeof reduce>[1], now: number) => {
        s = reduce(s, action, { now, rng, dictionary }).state;
      };
      step({ type: 'PRESENCE_JOIN', playerId: B, nickname: 'b', role: 'player' }, 1);
      step({ type: 'START', playerId: A, clientSeq: 1 }, 2);
      step({ type: 'TICK' }, 4000);
      step({ type: 'GUESS', playerId: A, word: 'CRANE', clientSeq: 2 }, 5000);
      step({ type: 'STEAL', playerId: B, targetId: A, word: 'SLATE', clientSeq: 1 }, 5001);
      return s;
    };
    expect(run()).toEqual(run());
  });
});

describe('disconnects (GR-35)', () => {
  it('guest disconnect > 15 s during play → forfeit, opponent wins', () => {
    const sim = new Sim().startPlaying();
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: B });
    expect(sim.p(B).connected).toBe(false);
    sim.advance(DEFAULT_SETTINGS.guestGraceMs - 1);
    expect(sim.state.phase).toBe('PLAYING');
    sim.advance(1);
    expect(sim.p(B)).toMatchObject({ status: 'eliminated', eliminationReason: 'forfeit' });
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'forfeit' });
  });

  it('guest reconnecting within the grace period keeps playing with its board intact', () => {
    const sim = new Sim().startPlaying();
    sim.guess(B, 'TRAIN');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: B });
    sim.advance(10_000);
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: B, nickname: 'bob', role: 'player' });
    sim.advance(30_000);
    expect(sim.p(B)).toMatchObject({ status: 'alive', connected: true, rowsUsed: 1 });
    expect(sim.p(B).disconnectedAt).toBeUndefined();
    expect(sim.state.phase).toBe('PLAYING');
  });

  it('a disconnected invulnerable player also forfeits (SRS §4.2)', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.guess(B, 'SLATE');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: B });
    sim.advance(DEFAULT_SETTINGS.guestGraceMs);
    expect(sim.state.result).toMatchObject({ winnerId: A, reason: 'forfeit' });
  });

  it('the host never forfeits through its own engine (GR-36 is handled by clients)', () => {
    const sim = new Sim().startPlaying();
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: A });
    sim.advance(60_000);
    expect(sim.p(A).status).toBe('alive');
  });

  it('ABANDON moves an active match to ABANDONED', () => {
    const sim = new Sim().startPlaying();
    sim.dispatch({ type: 'ABANDON' });
    expect(sim.state.phase).toBe('ABANDONED');
    expect(sim.state.result).toEqual({ outcome: 'abandoned', reason: 'abandoned' });
  });
});

describe('lobby roster (FR-2.3, E-16)', () => {
  it('a third joiner becomes a spectator; a ?watch=1 viewer is always a spectator', () => {
    const sim = new Sim();
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'pC', nickname: 'carol', role: 'player' });
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'pW', nickname: 'proj', role: 'spectator' });
    expect(sim.state.players.map((p) => p.id)).toEqual([A, B]);
    expect(sim.state.spectators.map((s) => s.id)).toEqual(['pC', 'pW']);
  });

  it('when a lobby player leaves, the earliest waiting would-be player is promoted (not watchers)', () => {
    const sim = new Sim();
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'pW', nickname: 'proj', role: 'spectator' });
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'pC', nickname: 'carol', role: 'player' });
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: B });
    expect(sim.state.players.map((p) => p.id)).toEqual([A, 'pC']);
    expect(sim.state.spectators.map((s) => s.id)).toEqual(['pW']);
  });

  it('joining mid-match makes you a spectator', () => {
    const sim = new Sim().startPlaying();
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'pC', nickname: 'carol', role: 'player' });
    expect(sim.state.spectators.map((s) => s.id)).toEqual(['pC']);
    expect(sim.state.players).toHaveLength(2);
  });
});

describe('rematch & return to lobby (GR-37)', () => {
  it('rematch resets every player, assigns new secrets and returns to the countdown', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'TRAIN');
    sim.steal(B, 'CRANE');
    expect(sim.state.phase).toBe('FINISHED');
    sim.dictionary = { ...sim.dictionary, answers: ['GHOST', 'PLUMB'] };
    expect(sim.client({ type: 'REMATCH', playerId: B }).rejections[0]?.reason).toBe('not_host');
    sim.client({ type: 'REMATCH', playerId: A });
    expect(sim.state.phase).toBe('COUNTDOWN');
    expect(sim.state.matchNumber).toBe(2);
    expect(sim.state.result).toBeUndefined();
    expect(sim.state.overtimeUsed).toBe(false);
    for (const p of sim.state.players) {
      expect(p).toMatchObject({ status: 'alive', rows: [], rowsUsed: 0, rowLimit: 6, postSolveStealRows: 0 });
      expect(p.eliminationReason).toBeUndefined();
    }
    expect([sim.p(A).secret, sim.p(B).secret]).toEqual(['GHOST', 'PLUMB']);
  });

  it('rematch is refused while the opponent is disconnected; return-to-lobby drops them', () => {
    const sim = new Sim().startPlaying();
    sim.steal(A, 'SLATE');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: B });
    expect(sim.client({ type: 'REMATCH', playerId: A }).rejections[0]?.reason).toBe('not_enough_players');
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'pC', nickname: 'carol', role: 'player' });
    sim.client({ type: 'RETURN_TO_LOBBY', playerId: A });
    expect(sim.state.phase).toBe('LOBBY');
    expect(sim.state.players.map((p) => p.id)).toEqual([A, 'pC']);
  });
});

describe('settings in the lobby (FIX 3 / FIX 5)', () => {
  it('host can toggle enableUnbeatableEarlyFinish in the lobby only', () => {
    const sim = new Sim();
    sim.client({ type: 'UPDATE_SETTINGS', playerId: A, patch: { enableUnbeatableEarlyFinish: false } });
    expect(sim.state.settings.enableUnbeatableEarlyFinish).toBe(false);
    expect(
      sim.client({ type: 'UPDATE_SETTINGS', playerId: B, patch: { enableUnbeatableEarlyFinish: true } })
        .rejections[0]?.reason,
    ).toBe('not_host');
    expect(sim.client({ type: 'UPDATE_SETTINGS', playerId: A, patch: { matchMs: -5 } }).rejections[0]?.reason).toBe(
      'invalid_settings',
    );
    sim.startPlaying();
    expect(
      sim.client({ type: 'UPDATE_SETTINGS', playerId: A, patch: { matchMs: 60_000 } }).rejections[0]?.reason,
    ).toBe('not_playing');
  });
});

describe('versioning', () => {
  it('a TICK with nothing due returns the same state object and does not bump the version', () => {
    const sim = new Sim().startPlaying();
    const before = sim.state;
    const res = sim.advance(1000);
    expect(res.changed).toBe(false);
    expect(sim.state).toBe(before);
  });

  it('every change bumps the version by exactly one', () => {
    const sim = new Sim().startPlaying();
    const v = sim.state.version;
    sim.guess(A, 'TRAIN');
    expect(sim.state.version).toBe(v + 1);
  });
});
