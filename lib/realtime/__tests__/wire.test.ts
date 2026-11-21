import { describe, expect, it } from 'vitest';
import { toPublicState } from '@/lib/engine/project';
import { createRng } from '@/lib/engine/rng';
import { reduce } from '@/lib/engine/reducer';
import { DEFAULT_SETTINGS, resolveSettings } from '@/lib/engine/settings';
import { createLobbyState } from '@/lib/engine/state';
import type { EngineAction, PrivateGameState, PublicGameState } from '@/lib/engine/types';
import { createDictionary, unpackWords } from '@/lib/words';
import { PACKED_ANSWERS } from '@/lib/words/answers';
import { PACKED_VALID } from '@/lib/words/valid';
import { applyDelta, decodeState, encodeState, isWireDelta, makeDelta } from '../wire';

const answers = unpackWords(PACKED_ANSWERS);
const dictionary = createDictionary(unpackWords(PACKED_VALID), answers);

/** A running 100-player match (real word lists) to diff against. */
function bigMatch() {
  const rng = createRng(5);
  let now = 1_000_000;
  const seqs = new Map<string, number>();
  let s: PrivateGameState = createLobbyState({
    roomCode: 'WIRE',
    hostId: 'p0',
    hostNickname: 'host',
    settings: resolveSettings({ maxPlayers: 100, enableUnbeatableEarlyFinish: false }, DEFAULT_SETTINGS),
  });
  const d = (a: EngineAction) => (s = reduce(s, a, { now, rng, dictionary }).state);
  const c = (a: { type: string; playerId: string } & Record<string, unknown>) => {
    const n = (seqs.get(a.playerId) ?? 0) + 1;
    seqs.set(a.playerId, n);
    return d({ ...a, clientSeq: n } as EngineAction);
  };
  for (let i = 1; i < 100; i++) d({ type: 'PRESENCE_JOIN', playerId: `p${i}`, nickname: `player ${i}`, role: 'player' });
  c({ type: 'START', playerId: 'p0' });
  now += 3000;
  d({ type: 'TICK' });
  // A few rows each so the state is realistically heavy.
  for (let round = 0; round < 4; round++) {
    for (const p of s.players) c({ type: 'GUESS', playerId: p.id, word: answers[(round * 131 + p.id.length * 17) % answers.length] });
  }
  return {
    get state() {
      return s;
    },
    pub: () => toPublicState(s, now),
    guess: (id: string, word: string) => c({ type: 'GUESS', playerId: id, word }),
    tick: (ms: number) => {
      now += ms;
      d({ type: 'TICK' });
    },
  };
}

describe('wire format', () => {
  it('encode → decode round-trips a public state exactly', () => {
    const m = bigMatch();
    const pub = m.pub();
    expect(decodeState(JSON.parse(JSON.stringify(encodeState(pub))))).toEqual(JSON.parse(JSON.stringify(pub)));
  });

  it('compact rows make a 100-player snapshot much smaller', () => {
    const pub = bigMatch().pub();
    const plain = JSON.stringify(pub).length;
    const wire = JSON.stringify(encodeState(pub)).length;
    expect(wire).toBeLessThan(plain * 0.6);
  });

  it('a delta rebuilds exactly the next state', () => {
    const m = bigMatch();
    const before = m.pub();
    m.guess('p7', 'CRANE');
    m.guess('p42', 'SLATE');
    const after = m.pub();
    const delta = JSON.parse(JSON.stringify(makeDelta(encodeState(before), encodeState(after))));
    expect(isWireDelta(delta)).toBe(true);
    const rebuilt = applyDelta(JSON.parse(JSON.stringify(before)) as PublicGameState, delta);
    expect(rebuilt).toEqual(JSON.parse(JSON.stringify(after)));
  });

  it('a guess in a 100-player game costs ~1 KB as a delta instead of the whole state', () => {
    const m = bigMatch();
    const before = encodeState(m.pub());
    m.guess('p13', 'GHOST');
    const after = encodeState(m.pub());
    const full = JSON.stringify(after).length;
    const delta = JSON.stringify(makeDelta(before, after)).length;
    expect(full).toBeGreaterThan(20_000);
    expect(delta).toBeLessThan(3_000);
  });

  it('removed fields and roster changes survive a delta (match end → standings, phase, result)', () => {
    const m = bigMatch();
    const before = m.pub();
    m.tick(DEFAULT_SETTINGS.matchMs + DEFAULT_SETTINGS.overtimeMs + 10);
    const after = m.pub();
    expect(after.phase).toBe('FINISHED');
    const rebuilt = applyDelta(before, makeDelta(encodeState(before), encodeState(after)));
    expect(rebuilt?.phase).toBe('FINISHED');
    expect(rebuilt?.phaseEndsAt).toBeUndefined(); // deleted field travels as null → removed
    expect(rebuilt?.result?.standings).toHaveLength(100);
  });

  it('a delta for a different base version is refused (client resyncs)', () => {
    const m = bigMatch();
    const before = m.pub();
    m.guess('p3', 'CRANE');
    const mid = m.pub();
    m.guess('p4', 'CRANE');
    const after = m.pub();
    const delta = makeDelta(encodeState(mid), encodeState(after));
    expect(applyDelta(before, delta)).toBeNull(); // missed the mid update
  });
});
