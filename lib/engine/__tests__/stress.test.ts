import { describe, expect, it } from 'vitest';
import { createDictionary, unpackWords } from '@/lib/words';
import { PACKED_ANSWERS } from '@/lib/words/answers';
import { PACKED_VALID } from '@/lib/words/valid';
import { findLeakedSecrets, toPublicState } from '../project';
import { createRng } from '../rng';
import { reduce } from '../reducer';
import { DEFAULT_SETTINGS, resolveSettings } from '../settings';
import { createLobbyState } from '../state';
import type { ClientAction, DistributiveOmit, EngineAction, PrivateGameState } from '../types';

/**
 * OPT-IN engine stress / fuzz test (STRESS=1): many complete 100-player battle royales through the
 * pure referee, with random own guesses, wrong AND correct steals, solves, illegal actions while
 * waiting, disconnects / reconnects / forfeits and long idle gaps (countdowns, timeouts, overtime,
 * drawn duels). After EVERY transition it checks the v1.1 invariants. A crash = a thrown error.
 *
 *   STRESS=1 npx vitest run lib/engine/__tests__/stress.test.ts
 */
const RUN = !!process.env.STRESS;
const MATCHES = Number(process.env.STRESS_MATCHES ?? 200);

function violations(s: PrivateGameState): string[] {
  const bad: string[] = [];
  if (s.phase !== 'PLAYING') return bad; // pairs freeze for the end screen once the match is over
  const byId = new Map(s.players.map((p) => [p.id, p]));
  const secrets = new Set<string>();
  for (const p of s.players) {
    if (p.status === 'eliminated') {
      if (p.duelPhase) bad.push(`${p.id}: eliminated with a duel clock`);
      continue;
    }
    if (s.phase === 'PLAYING') {
      if (secrets.has(p.secret)) bad.push(`${p.id}: duplicate live secret`);
      secrets.add(p.secret);
    }
    if (!p.targetId) {
      if (p.duelPhase) bad.push(`${p.id}: waiting with a duel clock`);
      continue;
    }
    const o = byId.get(p.targetId);
    if (!o || o.status === 'eliminated' || o.targetId !== p.id) bad.push(`${p.id}: pair not mutual`);
    else if (o.duelEndsAt !== p.duelEndsAt) bad.push(`${p.id}: pair clocks differ`);
    if (s.phase === 'PLAYING' && !p.duelPhase) bad.push(`${p.id}: paired without a duel clock`);
    if (p.rowsUsed > p.rowLimit) bad.push(`${p.id}: rows over the limit`);
  }
  if (s.phase === 'PLAYING' && s.players.filter((p) => p.status !== 'eliminated').length < 2) bad.push('match should be over');
  if (s.phase === 'PLAYING' && s.phaseEndsAt !== undefined) bad.push('global match clock in a battle royale');
  return bad;
}

describe.skipIf(!RUN)('engine stress: 100-player battle royales', () => {
  it(`${MATCHES} random 100-player matches finish cleanly with every invariant holding`, () => {
    const answers = unpackWords(PACKED_ANSWERS);
    const dictionary = createDictionary(unpackWords(PACKED_VALID), answers);
    const timings: number[] = [];
    let actions = 0;
    let maxReduceMs = 0;
    let draws = 0;
    let duelDraws = 0;
    let waitingAccepted = 0;
    let waitingTried = 0;
    let maxSnapshotKb = 0;
    const allBad: string[] = [];

    for (let m = 0; m < MATCHES; m++) {
      const rng = createRng(1000 + m);
      const settings = resolveSettings({ maxPlayers: 100, enableUnbeatableEarlyFinish: m % 2 === 0 }, DEFAULT_SETTINGS);
      let s = createLobbyState({ roomCode: 'ST', hostId: 'p0', hostNickname: 'p0', settings });
      let now = 1_000_000;
      const seq = new Map<string, number>();
      const step = (a: EngineAction) => {
        const t = performance.now();
        const res = reduce(s, a, { now, rng, dictionary });
        const ms = performance.now() - t;
        maxReduceMs = Math.max(maxReduceMs, ms);
        timings.push(ms);
        actions++;
        s = res.state;
        const bad = violations(s);
        if (bad.length) allBad.push(`match ${m}, action ${a.type}: ${bad[0]}`);
        return res;
      };
      const act = (a: DistributiveOmit<ClientAction, 'clientSeq'>) => {
        const n = (seq.get(a.playerId) ?? 0) + 1;
        seq.set(a.playerId, n);
        return step({ ...a, clientSeq: n } as ClientAction);
      };
      for (let i = 1; i < 100; i++) step({ type: 'PRESENCE_JOIN', playerId: `p${i}`, nickname: `p${i}`, role: 'player' });
      act({ type: 'START', playerId: 'p0' });

      for (let guard = 0; s.phase === 'PLAYING' && guard < 50_000; guard++) {
        now += 20 + Math.floor(rng() * 200);
        const r = rng();
        const live = s.players.filter((p) => p.status !== 'eliminated');
        const p = live[Math.floor(rng() * live.length)]!;
        const opp = p.targetId ? s.players.find((o) => o.id === p.targetId) : undefined;
        if (r < 0.01) {
          now += 30_000 + Math.floor(rng() * 150_000); // long idle gap: countdowns, timeouts, overtime, draws
          step({ type: 'TICK' });
        } else if (r < 0.02 && p.id !== 'p0') {
          step({ type: p.connected ? 'PRESENCE_LEAVE' : 'PRESENCE_JOIN', playerId: p.id, nickname: p.id, role: 'player' } as EngineAction);
        } else if (!opp) {
          waitingTried++;
          const before = p.rows.length;
          act({ type: 'GUESS', playerId: p.id, word: answers[Math.floor(rng() * answers.length)]! });
          if ((s.players.find((x) => x.id === p.id)?.rows.length ?? 0) > before) waitingAccepted++;
        } else if (r < 0.04) {
          act({ type: 'STEAL', playerId: p.id, targetId: opp.id, word: opp.secret }); // a correct steal
        } else if (r < 0.06 && p.status === 'alive') {
          act({ type: 'GUESS', playerId: p.id, word: p.secret }); // a solve
        } else if (r < 0.25) {
          act({ type: 'STEAL', playerId: p.id, targetId: opp.id, word: answers[Math.floor(rng() * answers.length)]! });
        } else {
          act({ type: 'GUESS', playerId: p.id, word: answers[Math.floor(rng() * answers.length)]! });
        }
        if (actions % 50 === 0) {
          const pub = toPublicState(s, now);
          expect(findLeakedSecrets(s, pub)).toEqual([]);
          maxSnapshotKb = Math.max(maxSnapshotKb, JSON.stringify(pub).length / 1024);
        }
      }
      expect(s.phase, `match ${m} did not finish`).toBe('FINISHED');
      expect(s.result?.standings).toHaveLength(100);
      if (s.result?.outcome === 'draw') draws++;
      duelDraws += s.players.filter((p) => p.eliminationReason === 'duel_draw').length / 2;
    }

    timings.sort((a, b) => a - b);
    const pct = (q: number) => timings[Math.floor((q / 100) * (timings.length - 1))]!.toFixed(3);
    console.log(
      'STRESS',
      JSON.stringify({
        matches: MATCHES,
        actions,
        reduceMsP50: pct(50),
        reduceMsP99: pct(99),
        reduceMsMax: maxReduceMs.toFixed(2),
        matchDraws: draws,
        duelDraws,
        waitingActionsTried: waitingTried,
        waitingActionsAccepted: waitingAccepted,
        maxSnapshotKb: Math.round(maxSnapshotKb),
        violations: allBad.length,
      }),
    );
    expect(allBad.slice(0, 5)).toEqual([]);
    expect(waitingAccepted).toBe(0);
  }, 900_000);
});
