import { describe, expect, it } from 'vitest';
import { createDictionary, unpackWords } from '@/lib/words';
import { PACKED_ANSWERS } from '@/lib/words/answers';
import { PACKED_VALID } from '@/lib/words/valid';
import { createRng } from '../rng';
import { DEFAULT_SETTINGS, resolveSettings } from '../settings';
import { createLobbyState } from '../state';
import type { GameSettings, PrivateGameState, PrivatePlayer, ReduceResult, WordDictionary } from '../types';
import { EngineHarness, TEST_WORDS, testDictionary } from './helpers';

const SECRETS = ['CRANE', 'SLATE', 'GHOST', 'PLUMB', 'FJORD', 'WALTZ', 'NYMPH', 'QUICK'];

/** N-player driver (host = p0). Secrets are forced to SECRETS[i] right after START. */
class BrSim extends EngineHarness {
  constructor(n: number, opts: { settings?: Partial<GameSettings>; seed?: number; dictionary?: WordDictionary } = {}) {
    const settings = resolveSettings({ maxPlayers: Math.max(2, n), ...opts.settings }, DEFAULT_SETTINGS);
    super(
      createLobbyState({ roomCode: 'BR', hostId: 'p0', hostNickname: 'p0', settings }),
      opts.dictionary ?? testDictionary(SECRETS),
      createRng(opts.seed ?? 7),
    );
    for (let i = 1; i < n; i++) this.dispatch({ type: 'PRESENCE_JOIN', playerId: `p${i}`, nickname: `p${i}`, role: 'player' });
  }

  start(forceSecrets = true): this {
    this.client({ type: 'START', playerId: 'p0' });
    if (forceSecrets) this.state.players.forEach((p, i) => (p.secret = SECRETS[i] as string));
    this.advance(this.state.settings.countdownMs);
    return this;
  }

  /** Steal the stealer's CURRENT target's word. */
  stealTarget(stealerId: string): ReduceResult {
    const t = this.p(this.p(stealerId).targetId as string);
    return this.client({ type: 'STEAL', playerId: stealerId, targetId: t.id, word: t.secret });
  }

  /** Pairs fight it out, one winning steal at a time, until the match is over. */
  playToLastStanding(): void {
    for (let guard = 0; guard < 300 && (this.state.phase === 'PLAYING' || this.state.phase === 'OVERTIME'); guard++) {
      const fighter = this.state.players.find(
        (p) => p.status === 'alive' && p.targetId !== undefined && this.p(p.targetId).status === 'alive',
      );
      if (!fighter) throw new Error('no fight left to play');
      this.stealTarget(fighter.id);
    }
  }

  /** Never burns with anyone's secret, so a burn can't accidentally solve or steal. */
  override burn(playerId: string, n: number): void {
    super.burn(playerId, n, SECRETS);
  }
}

const realDictionary = () => createDictionary(unpackWords(PACKED_VALID), unpackWords(PACKED_ANSWERS));

/**
 * The pairing invariant: every player in play fights at most ONE opponent, that opponent is still in
 * play, and they fight them back (A↔B). Returns the violations (empty = OK).
 */
function pairViolations(state: PrivateGameState): string[] {
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const bad: string[] = [];
  for (const p of state.players) {
    if (p.status === 'eliminated' || p.targetId === undefined) continue;
    const o = byId.get(p.targetId);
    if (!o || o.id === p.id || o.status === 'eliminated' || o.targetId !== p.id) bad.push(`${p.id}→${p.targetId}`);
  }
  return bad;
}
const waitingIds = (sim: BrSim) => sim.state.players.filter((p) => p.status !== 'eliminated' && !p.targetId).map((p) => p.id);
const anyPaired = (sim: BrSim) => (sim.state.players.find((p) => p.status === 'alive' && p.targetId) as PrivatePlayer).id;

describe('battle royale — lobby & settings (host-only player cap 2…100)', () => {
  it('admits up to maxPlayers; later joiners spectate', () => {
    const sim = new BrSim(4);
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'late', nickname: 'late', role: 'player' });
    expect(sim.state.players.map((p) => p.id)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(sim.state.spectators.map((s) => s.id)).toEqual(['late']);
  });

  it('only the host can change the cap; lowering it parks the newest players, raising it lets them back', () => {
    const sim = new BrSim(4);
    expect(sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p1', patch: { maxPlayers: 10 } }).rejections[0]?.reason).toBe(
      'not_host',
    );
    sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p0', patch: { maxPlayers: 2 } });
    expect(sim.state.players.map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(sim.state.spectators.map((s) => s.id).sort()).toEqual(['p2', 'p3']);
    sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p0', patch: { maxPlayers: 100 } });
    expect(sim.state.players.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p0', patch: { maxPlayers: 101 } }).rejections[0]?.reason).toBe(
      'invalid_settings',
    );
  });

  it('starts with any number of connected players from 2 up to the cap', () => {
    const sim = new BrSim(2, { settings: { maxPlayers: 100 } });
    sim.client({ type: 'START', playerId: 'p0' });
    expect(sim.state.phase).toBe('COUNTDOWN');
  });
});

describe('battle royale — symmetric pairs (A↔B, C↔D, …)', () => {
  it('every player is paired with exactly ONE opponent, who is paired with them in return', () => {
    const sim = new BrSim(8).start();
    expect(pairViolations(sim.state)).toEqual([]);
    expect(waitingIds(sim)).toEqual([]);
    for (const p of sim.state.players) expect(sim.p(p.targetId as string).targetId).toBe(p.id);
    expect(new Set(sim.state.players.map((p) => [p.id, p.targetId].sort().join('↔'))).size).toBe(4); // 4 duels
  });

  it('with an odd number of players exactly one waits for an opponent', () => {
    for (const n of [3, 5, 7, 99]) {
      const big = n > SECRETS.length;
      const sim = new BrSim(n, { settings: { maxPlayers: n }, ...(big ? { dictionary: realDictionary() } : {}) }).start(!big);
      expect(pairViolations(sim.state)).toEqual([]);
      expect(waitingIds(sim)).toHaveLength(1);
    }
  });

  it('pairs are random — they change with the seed — but replay identically for the same seed (NFR-8)', () => {
    const pairing = (seed: number) => new BrSim(8, { seed }).start().state.players.map((p) => p.targetId);
    expect(pairing(99)).toEqual(pairing(99));
    expect(new Set([1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(pairing(seed)))).size).toBeGreaterThan(1);
  });

  it('a duel is a single pair: you fight the other player', () => {
    const sim = new BrSim(2).start();
    expect(sim.p('p0').targetId).toBe('p1');
    expect(sim.p('p1').targetId).toBe('p0');
  });

  it('you can only steal from your own opponent', () => {
    const sim = new BrSim(6).start();
    const outsider = sim.state.players.find((p) => p.id !== 'p0' && p.id !== sim.p('p0').targetId) as PrivatePlayer;
    expect(sim.client({ type: 'STEAL', playerId: 'p0', targetId: outsider.id, word: outsider.secret }).rejections[0]?.reason).toBe(
      'invalid_target',
    );
    expect(sim.p('p0').rowsUsed).toBe(0);
    expect(sim.p(outsider.id).status).toBe('alive');
    const opponent = sim.p('p0').targetId as string;
    sim.stealTarget('p0');
    expect(sim.p(opponent)).toMatchObject({ status: 'eliminated', eliminatedBy: 'p0' });
  });

  it('knock out your opponent and you are paired with the player who was waiting; the match continues', () => {
    const sim = new BrSim(5).start();
    const [waiting] = waitingIds(sim);
    const winner = anyPaired(sim);
    const loser = sim.p(winner).targetId as string;
    const res = sim.stealTarget(winner);
    expect(sim.p(loser)).toMatchObject({ status: 'eliminated', eliminationReason: 'stolen', eliminatedBy: winner });
    expect(sim.state.phase).toBe('PLAYING');
    expect(sim.p(winner).targetId).toBe(waiting);
    expect(sim.p(waiting as string).targetId).toBe(winner);
    expect(pairViolations(sim.state)).toEqual([]);
    const changed = res.events.filter((e) => e.type === 'TARGET_CHANGED').map((e) => (e as { playerId: string }).playerId);
    expect(changed.sort()).toEqual([winner, waiting].sort());
  });

  it('with nobody free you wait — and nobody can steal from you — until another fight ends', () => {
    const sim = new BrSim(4).start();
    sim.stealTarget('p0');
    expect(sim.p('p0').targetId).toBeUndefined(); // the other pair is still fighting
    const [c, d] = sim.state.players.filter((p) => p.status === 'alive' && p.id !== 'p0').map((p) => p.id) as [string, string];
    expect(sim.p(c).targetId).toBe(d);
    expect(sim.client({ type: 'STEAL', playerId: c, targetId: 'p0', word: sim.p('p0').secret }).rejections[0]?.reason).toBe(
      'invalid_target',
    );
    sim.stealTarget(c); // c knocks d out → the two winners are paired
    expect(sim.p('p0').targetId).toBe(c);
    expect(sim.p(c).targetId).toBe('p0');
  });

  it('when your opponent solves you stay paired: they get free steal shots at you, you can’t steal back', () => {
    const sim = new BrSim(4, { settings: { enableUnbeatableEarlyFinish: false } }).start();
    const solver = sim.p('p0').targetId as string;
    sim.guess(solver, sim.p(solver).secret);
    expect(sim.p(solver).status).toBe('invulnerable');
    expect(sim.p('p0').targetId).toBe(solver);
    expect(sim.p(solver).targetId).toBe('p0');
    expect(sim.stealTarget('p0').rejections[0]?.reason).toBe('target_shielded');
    sim.stealTarget(solver); // a free steal shot
    expect(sim.p('p0')).toMatchObject({ status: 'eliminated', eliminatedBy: solver });
  });

  it('a pair that can no longer fight splits up, and the unsolved player is paired again', () => {
    const sim = new BrSim(5, { settings: { enableUnbeatableEarlyFinish: false } }).start();
    const [waiting] = waitingIds(sim);
    const x = anyPaired(sim);
    const y = sim.p(x).targetId as string;
    sim.guess(y, sim.p(y).secret); // y solves: shielded, with free steal shots at x
    expect(sim.p(x).targetId).toBe(y);
    for (const w of TEST_WORDS.filter((t) => !SECRETS.includes(t)).slice(0, 3)) {
      sim.client({ type: 'STEAL', playerId: y, targetId: x, word: w }); // three misses
    }
    expect(sim.p(y).postSolveStealRows).toBe(0); // neither can steal from the other any more
    expect(sim.p(x).targetId).toBe(waiting);
    expect(sim.p(waiting as string).targetId).toBe(x);
    expect(sim.p(y).targetId).toBeUndefined();
    expect(pairViolations(sim.state)).toEqual([]);
  });

  it('a solved player with free steal shots left can be paired with a lone unsolved player', () => {
    const sim = new BrSim(5, { settings: { enableUnbeatableEarlyFinish: false } }).start();
    const [waiting] = waitingIds(sim);
    const x = anyPaired(sim);
    const y = sim.p(x).targetId as string;
    sim.guess(y, sim.p(y).secret); // y solves
    sim.stealTarget(y); // …and knocks x out with a free shot (2 left)
    expect(sim.p(y).targetId).toBe(waiting);
    expect(sim.p(waiting as string).targetId).toBe(y);
  });

  it('a forfeit frees the opponent, who is paired again; play continues', () => {
    const sim = new BrSim(5).start();
    const [waiting] = waitingIds(sim);
    const quitter = (sim.state.players.find((p) => p.targetId && p.id !== 'p0') as PrivatePlayer).id; // the host can't forfeit
    const partner = sim.p(quitter).targetId as string;
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: quitter });
    sim.now += DEFAULT_SETTINGS.guestGraceMs;
    sim.dispatch({ type: 'TICK' });
    expect(sim.p(quitter)).toMatchObject({ status: 'eliminated', eliminationReason: 'forfeit' });
    expect(sim.state.phase).toBe('PLAYING');
    expect(sim.p(partner).targetId).toBe(waiting);
    expect(sim.p(waiting as string).targetId).toBe(partner);
  });
});

describe('battle royale — how a match ends', () => {
  it('last one standing wins; placings run winner → most recently out → first out', () => {
    const sim = new BrSim(3).start();
    const [second] = waitingIds(sim);
    const winner = anyPaired(sim);
    const first = sim.p(winner).targetId as string;
    sim.stealTarget(winner);
    expect(sim.state.phase).toBe('PLAYING');
    expect(sim.p(winner).targetId).toBe(second); // paired with the player who was waiting
    sim.now += 1000;
    sim.stealTarget(winner);
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.state.result).toMatchObject({ outcome: 'win', winnerId: winner, reason: 'stolen' });
    expect(sim.state.result?.standings).toEqual([
      { playerId: winner, place: 1 },
      { playerId: second, place: 2 },
      { playerId: first, place: 3 },
    ]);
  });

  it('when everyone still standing has solved, the best solve wins', () => {
    const sim = new BrSim(3, { settings: { enableUnbeatableEarlyFinish: false } }).start();
    sim.burn('p1', 1);
    sim.guess('p1', sim.p('p1').secret); // p1: 2 rows
    sim.burn('p2', 2);
    sim.guess('p2', sim.p('p2').secret); // p2: 3 rows
    expect(sim.state.phase).toBe('PLAYING'); // p0 still alive
    sim.guess('p0', sim.p('p0').secret); // p0: 1 row — best
    expect(sim.state.result).toMatchObject({ winnerId: 'p0', reason: 'fewer_rows' });
    expect(sim.state.result?.standings?.map((s) => s.playerId)).toEqual(['p0', 'p1', 'p2']);
  });

  it('generalised GR-28: ends as soon as no unsolved player can beat the best solve', () => {
    const sim = new BrSim(3).start();
    sim.burn('p1', 1);
    sim.burn('p2', 2);
    sim.burn('p0', 1);
    sim.guess('p0', sim.p('p0').secret); // p0 solved in 2; p1 has 1 (>= 1), p2 has 2 → nobody can beat it
    expect(sim.state.result).toMatchObject({ winnerId: 'p0', reason: 'unbeatable' });
  });

  it('…but keeps going while somebody could still beat it', () => {
    const sim = new BrSim(3).start();
    sim.burn('p1', 1);
    sim.burn('p0', 1);
    sim.guess('p0', sim.p('p0').secret); // p0 solved in 2; p2 has 0 rows → could solve in 1
    expect(sim.state.phase).toBe('PLAYING');
  });

  it('timeout with a solver: solvers first, then survivors, then the eliminated', () => {
    const sim = new BrSim(4, { settings: { enableUnbeatableEarlyFinish: false } }).start();
    sim.burn('p3', 2);
    sim.guess('p3', sim.p('p3').secret); // solver
    const victim = sim.p('p0').targetId === 'p3' ? null : (sim.p('p0').targetId as string);
    if (victim) sim.stealTarget('p0');
    sim.now += DEFAULT_SETTINGS.matchMs;
    sim.dispatch({ type: 'TICK' });
    expect(sim.state.result).toMatchObject({ winnerId: 'p3', reason: 'timeout_solver' });
    const order = sim.state.result?.standings?.map((s) => s.playerId) ?? [];
    expect(order[0]).toBe('p3');
    if (victim) expect(order.at(-1)).toBe(victim);
    expect(new Set(order).size).toBe(4);
  });

  it('timeout with nobody solved → overtime: every alive player gets +3 rows', () => {
    const sim = new BrSim(5).start();
    sim.stealTarget(anyPaired(sim));
    sim.now += DEFAULT_SETTINGS.matchMs;
    sim.dispatch({ type: 'TICK' });
    expect(sim.state.phase).toBe('OVERTIME');
    for (const p of sim.state.players) {
      expect(p.rowLimit).toBe(p.status === 'alive' ? 9 : 6);
    }
  });

  it('rematch drops players who left and starts with the rest', () => {
    const sim = new BrSim(4).start();
    sim.dispatch({ type: 'ABANDON' });
    sim.client({ type: 'RETURN_TO_LOBBY', playerId: 'p0' });
    sim.start();
    sim.playToLastStanding();
    expect(sim.state.phase).toBe('FINISHED');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: 'p3' });
    sim.client({ type: 'REMATCH', playerId: 'p0' });
    expect(sim.state.phase).toBe('COUNTDOWN');
    expect(sim.state.players.map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
  });
});

describe('battle royale — starting below the cap, late joiners, next match', () => {
  it('a host alone can never start, even with a big cap', () => {
    const sim = new BrSim(1, { settings: { maxPlayers: 100 } });
    expect(sim.client({ type: 'START', playerId: 'p0' }).rejections[0]?.reason).toBe('not_enough_players');
    expect(sim.state.phase).toBe('LOBBY');
  });

  it('20 players can start a 100-player room — no need to fill it', () => {
    const dictionary = createDictionary(unpackWords(PACKED_VALID), unpackWords(PACKED_ANSWERS));
    const sim = new BrSim(20, { settings: { maxPlayers: 100 }, dictionary });
    sim.client({ type: 'START', playerId: 'p0' });
    expect(sim.state.phase).toBe('COUNTDOWN');
    expect(sim.state.players).toHaveLength(20);
  });

  it('people who join mid-match spectate it, then play the next match when the host starts it again', () => {
    const sim = new BrSim(3, { settings: { maxPlayers: 100 } }).start();
    for (let i = 0; i < 5; i++) sim.dispatch({ type: 'PRESENCE_JOIN', playerId: `late${i}`, nickname: `late ${i}`, role: 'player' });
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'projector', nickname: 'proj', role: 'spectator' });
    expect(sim.state.players).toHaveLength(3);
    expect(sim.state.spectators).toHaveLength(6);
    sim.playToLastStanding();
    expect(sim.state.phase).toBe('FINISHED');
    sim.client({ type: 'REMATCH', playerId: 'p0' });
    expect(sim.state.phase).toBe('COUNTDOWN');
    expect(sim.state.players.map((p) => p.id)).toEqual(['p0', 'p1', 'p2', 'late0', 'late1', 'late2', 'late3', 'late4']);
    expect(sim.state.spectators.map((s) => s.id)).toEqual(['projector']); // ?watch=1 viewers keep watching
  });

  it('spectators are unlimited but seats stop at the cap; the rest keep waiting in line', () => {
    const sim = new BrSim(2, { settings: { maxPlayers: 3 } }).start();
    for (let i = 0; i < 150; i++) sim.dispatch({ type: 'PRESENCE_JOIN', playerId: `s${i}`, nickname: `s${i}`, role: 'player' });
    expect(sim.state.spectators).toHaveLength(150);
    sim.stealTarget('p0');
    sim.client({ type: 'REMATCH', playerId: 'p0' });
    expect(sim.state.players.map((p) => p.id)).toEqual(['p0', 'p1', 's0']);
    expect(sim.state.spectators).toHaveLength(149);
  });

  it('rematch works with the host plus a waiting spectator even if every other player left', () => {
    const sim = new BrSim(2).start();
    sim.stealTarget('p0');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: 'p1' });
    expect(sim.client({ type: 'REMATCH', playerId: 'p0' }).rejections[0]?.reason).toBe('not_enough_players');
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'newbie', nickname: 'newbie', role: 'player' });
    sim.client({ type: 'REMATCH', playerId: 'p0' });
    expect(sim.state.phase).toBe('COUNTDOWN');
    expect(sim.state.players.map((p) => p.id)).toEqual(['p0', 'newbie']);
  });
});

describe('battle royale — 100 players', () => {
  it('a full 100-player match with real word lists runs to a valid finish quickly', () => {
    const answers = unpackWords(PACKED_ANSWERS);
    const dictionary = createDictionary(unpackWords(PACKED_VALID), answers);
    // Early finish off: with 100 players one lucky first-row solve would otherwise end it instantly.
    const sim = new BrSim(100, { seed: 2026, dictionary, settings: { maxPlayers: 100, enableUnbeatableEarlyFinish: false } });
    expect(sim.state.players).toHaveLength(100);
    const t0 = performance.now();
    sim.start(false);
    expect(new Set(sim.state.players.map((p) => p.secret)).size).toBe(100); // GR-2 across 100 players
    // 100 players → 50 random duels, everyone paired, all mutual.
    expect(pairViolations(sim.state)).toEqual([]);
    expect(waitingIds(sim)).toEqual([]);
    expect(new Set(sim.state.players.map((p) => [p.id, p.targetId].sort().join('↔'))).size).toBe(50);
    const violations: string[] = [];

    const rng = createRng(1);
    let actions = 0;
    let steals = 0;
    while (sim.state.phase === 'PLAYING' || sim.state.phase === 'OVERTIME') {
      sim.now += 120;
      const alive = sim.state.players.filter((p) => p.status !== 'eliminated');
      const p = alive[Math.floor(rng() * alive.length)] as PrivatePlayer;
      const roll = rng();
      const target = p.targetId ? sim.p(p.targetId) : undefined;
      if (roll < 0.04 && p.status === 'alive' && p.rowsUsed >= 3) sim.guess(p.id, p.secret);
      else if (roll < 0.2 && target) {
        if (!sim.client({ type: 'STEAL', playerId: p.id, targetId: target.id, word: target.secret }).rejections.length) steals++;
      }
      else if (p.status === 'alive') sim.guess(p.id, answers[Math.floor(rng() * answers.length)] as string);
      else sim.dispatch({ type: 'TICK' });
      actions++;
      if (sim.state.phase === 'PLAYING' || sim.state.phase === 'OVERTIME') violations.push(...pairViolations(sim.state));
      if (actions > 20_000) throw new Error('match did not finish');
    }
    const ms = performance.now() - t0;

    const result = sim.state.result!;
    expect(sim.state.phase).toBe('FINISHED');
    const standings = result.standings!;
    expect(standings).toHaveLength(100);
    expect(new Set(standings.map((s) => s.playerId)).size).toBe(100);
    expect(standings.map((s) => s.place)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    if (result.outcome === 'win') expect(standings[0]?.playerId).toBe(result.winnerId);
    expect(violations).toEqual([]); // pairs stayed mutual after every single action
    expect(steals).toBeGreaterThan(20); // the match really was a battle royale, not a one-move finish
    expect(sim.state.players.filter((pl) => pl.status === 'eliminated').length).toBeGreaterThan(20);
    expect(ms).toBeLessThan(15_000); // the host referee keeps up comfortably
  });
});
