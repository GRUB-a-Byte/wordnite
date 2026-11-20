import { describe, expect, it } from 'vitest';
import { toPublicState } from '@/lib/engine/project';
import { A, B, Sim } from '@/lib/engine/__tests__/helpers';
import { explainResult, perspectiveOf, REASON_TEXT } from '../copy';
import { generatePlayerId, generateRoomCode, isValidRoomCode, normalizeRoomCode } from '../ids';
import { keyStates, rowsScoredAgainst } from '../keyboard';
import { sanitizeNickname } from '../nickname';

describe('room codes & ids (FR-1.2)', () => {
  it('codes are 4 letters from the unambiguous alphabet (no I, O, 0, 1)', () => {
    for (let i = 0; i < 2000; i++) {
      const c = generateRoomCode();
      expect(c).toMatch(/^[A-HJ-NP-Z]{4}$/);
      expect(isValidRoomCode(c)).toBe(true);
    }
    expect(isValidRoomCode('ABIO')).toBe(false);
    expect(normalizeRoomCode(' kx-qt9 ')).toBe('KXQT');
  });

  it('player ids are lower-case (never collide with upper-case secret words)', () => {
    for (let i = 0; i < 200; i++) expect(generatePlayerId()).toMatch(/^[a-z0-9]{10,}$/);
  });
});

describe('nickname sanitising (NFR-16)', () => {
  it('trims, collapses whitespace and caps at 16 characters', () => {
    expect(sanitizeNickname('   word    wizard   ')).toBe('word wizard');
    expect(sanitizeNickname('x'.repeat(30))).toHaveLength(16);
  });
  it('masks profanity, including simple leetspeak', () => {
    expect(sanitizeNickname('shithead')).toBe('****head');
    expect(sanitizeNickname('fUcK')).toBe('****');
    expect(sanitizeNickname('sh1t')).toBe('****');
    expect(sanitizeNickname('Scunthorpe')).toContain('*'); // conservative by design
    expect(sanitizeNickname('alice')).toBe('alice');
  });
});

describe('keyboard colouring (FR-3.5)', () => {
  it('best state wins: correct > present > absent', () => {
    const sim = new Sim().startPlaying(); // A = CRANE
    sim.guess(A, 'TRAIN'); // R,A correct; N present; T,I absent
    sim.guess(A, 'NYMPH'); // N present again; nothing upgrades or downgrades
    const ks = keyStates(sim.p(A).rows);
    expect(ks.R).toBe('correct');
    expect(ks.A).toBe('correct');
    expect(ks.N).toBe('present');
    expect(ks.T).toBe('absent');
  });

  it('rows scored against a target include the OPPONENT’s steal rows at that target', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'TRAIN'); // vs CRANE (A's own)
    sim.steal(B, 'GHOST'); // vs CRANE (B attacking A)
    sim.guess(B, 'MOUND'); // vs SLATE — must NOT be included for A
    const pub = toPublicState(sim.state, sim.now);
    const me = pub.players.find((p) => p.id === A)!;
    const words = rowsScoredAgainst(me, pub.players).map((r) => r.word);
    expect(words.sort()).toEqual(['GHOST', 'TRAIN']);
  });
});

describe('outcome copy (FR-6.1, FIX 5)', () => {
  it('an unbeatable finish never claims a steal or elimination', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'CRANE'); // instant unbeatable win
    const pub = toPublicState(sim.state, sim.now);
    const result = pub.result!;
    expect(result.reason).toBe('unbeatable');
    const forLoser = explainResult(result, pub.players, B);
    expect(forLoser.toLowerCase()).not.toContain('stole');
    expect(forLoser.toLowerCase()).toContain('not eliminated');
    expect(REASON_TEXT[result.reason]).toBe('Opponent can’t catch up');
    expect(perspectiveOf(result, A, true)).toBe('win');
    expect(perspectiveOf(result, B, true)).toBe('lose');
    expect(perspectiveOf(result, 'someone', false)).toBe('spectator');
  });

  it('a steal is described as a steal', () => {
    const sim = new Sim().startPlaying();
    sim.steal(B, 'CRANE');
    const pub = toPublicState(sim.state, sim.now);
    expect(explainResult(pub.result!, pub.players, A)).toBe('bob stole your word.');
    expect(explainResult(pub.result!, pub.players, B)).toBe('You stole alice’s word!');
  });

  it('draws read as draws', () => {
    const sim = new Sim().startPlaying();
    sim.advance(sim.state.settings.matchMs);
    sim.advance(sim.state.settings.overtimeMs);
    const pub = toPublicState(sim.state, sim.now);
    expect(perspectiveOf(pub.result, A, true)).toBe('draw');
    expect(REASON_TEXT[pub.result!.reason]).toBe('Overtime expired — everybody loses');
  });
});
