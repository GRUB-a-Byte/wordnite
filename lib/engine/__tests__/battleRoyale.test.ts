import { describe, expect, it } from 'vitest';
import { createDictionary, unpackWords } from '@/lib/words';
import { PACKED_ANSWERS } from '@/lib/words/answers';
import { PACKED_VALID } from '@/lib/words/valid';
import { attackerCount } from '../pairing';
import { createRng } from '../rng';
import { DEFAULT_SETTINGS, resolveSettings } from '../settings';
import { createLobbyState } from '../state';
import type { GameSettings, PrivatePlayer, ReduceResult, WordDictionary } from '../types';
import { EngineHarness, testDictionary } from './helpers';

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

  /** Never burns with anyone's secret, so a burn can't accidentally solve or steal. */
  override burn(playerId: string, n: number): void {
    super.burn(playerId, n, SECRETS);
  }
}

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

describe('battle royale — targets', () => {
  it('every player gets their own random shortlist of 3 stealable opponents and has chosen one', () => {
    const sim = new BrSim(8).start();
    for (const p of sim.state.players) {
      const opts = p.targetOptions ?? [];
      expect(opts).toHaveLength(3);
      expect(new Set(opts).size).toBe(3);
      expect(opts).not.toContain(p.id);
      for (const id of opts) expect(sim.p(id).status).toBe('alive');
      expect(opts).toContain(p.targetId);
    }
  });

  it('no two players get the identical shortlist, and attention is spread evenly', () => {
    for (const n of [5, 8, 20]) {
      const dictionary = createDictionary(unpackWords(PACKED_VALID), unpackWords(PACKED_ANSWERS));
      const sim = new BrSim(n, { settings: { maxPlayers: Math.max(2, n) }, dictionary, seed: n }).start(false);
      const keys = sim.state.players.map((p) => [...(p.targetOptions ?? [])].sort().join('|'));
      expect(new Set(keys).size).toBe(n);
      const exposure = sim.state.players.map((p) => sim.state.players.filter((q) => q.targetOptions?.includes(p.id)).length);
      expect(Math.max(...exposure) - Math.min(...exposure)).toBeLessThanOrEqual(2);
    }
  });

  it('a duel needs no choice: your only option is the other player', () => {
    const sim = new BrSim(2).start();
    expect(sim.p('p0').targetOptions).toEqual(['p1']);
    expect(sim.p('p1').targetOptions).toEqual(['p0']);
  });

  it('shortlists are deterministic for a given seed (NFR-8)', () => {
    const run = () => new BrSim(6, { seed: 99 }).start().state.players.map((p) => [p.targetOptions, p.targetId]);
    expect(run()).toEqual(run());
  });

  it('you may steal from anyone on your shortlist — and nobody else', () => {
    const sim = new BrSim(8).start();
    const me = sim.p('p0');
    const outsider = sim.state.players.find((p) => p.id !== me.id && !me.targetOptions?.includes(p.id)) as PrivatePlayer;
    expect(sim.client({ type: 'STEAL', playerId: 'p0', targetId: outsider.id, word: outsider.secret }).rejections[0]?.reason).toBe(
      'invalid_target',
    );
    expect(sim.p('p0').rowsUsed).toBe(0);
    const notChosen = (me.targetOptions ?? []).find((id) => id !== me.targetId) as string;
    sim.client({ type: 'STEAL', playerId: 'p0', targetId: notChosen, word: sim.p(notChosen).secret });
    expect(sim.p(notChosen).status).toBe('eliminated');
  });

  it('SET_TARGET picks whom to attack from your shortlist (validated by the referee)', () => {
    const sim = new BrSim(8).start();
    const opts = sim.p('p0').targetOptions ?? [];
    const pick = opts[2] as string;
    sim.client({ type: 'SET_TARGET', playerId: 'p0', targetId: pick });
    expect(sim.p('p0').targetId).toBe(pick);
    const outsider = sim.state.players.find((p) => p.id !== 'p0' && !opts.includes(p.id)) as PrivatePlayer;
    expect(sim.client({ type: 'SET_TARGET', playerId: 'p0', targetId: outsider.id }).rejections[0]?.reason).toBe('invalid_target');
    expect(sim.p('p0').targetId).toBe(pick);
    expect(attackerCount(sim.state.players, pick)).toBeGreaterThanOrEqual(1);
  });

  it('when one option is knocked out only that slot is refilled; the other options stay', () => {
    const sim = new BrSim(8).start();
    const before = [...(sim.p('p0').targetOptions ?? [])];
    const victim = before[0] as string;
    sim.client({ type: 'STEAL', playerId: 'p0', targetId: victim, word: sim.p(victim).secret });
    const after = sim.p('p0').targetOptions ?? [];
    expect(after).toHaveLength(3);
    expect(after).not.toContain(victim);
    for (const id of before.slice(1)) expect(after).toContain(id);
    for (const p of sim.state.players) expect(p.targetOptions ?? []).not.toContain(victim);
  });

  it('a successful steal knocks the target out but the match continues; hunters get new targets', () => {
    const sim = new BrSim(4).start();
    const victimId = sim.p('p0').targetId as string;
    const otherHunters = sim.state.players.filter((p) => p.id !== 'p0' && p.targetId === victimId).map((p) => p.id);
    const res = sim.stealTarget('p0');
    expect(sim.p(victimId)).toMatchObject({ status: 'eliminated', eliminationReason: 'stolen', eliminatedBy: 'p0' });
    expect(sim.state.phase).toBe('PLAYING');
    const newTarget = sim.p('p0').targetId as string;
    expect(newTarget).not.toBe(victimId);
    expect(sim.p(newTarget).status).toBe('alive');
    for (const h of otherHunters) expect(sim.p(h).targetId).not.toBe(victimId);
    const changed = res.events.filter((e) => e.type === 'TARGET_CHANGED').map((e) => (e as { playerId: string }).playerId);
    expect(changed).toContain('p0');
  });

  it('when your target solves, you are retargeted to someone still stealable', () => {
    const sim = new BrSim(3, { settings: { enableUnbeatableEarlyFinish: false } }).start();
    const solverId = sim.p('p0').targetId as string;
    sim.guess(solverId, sim.p(solverId).secret);
    expect(sim.p(solverId).status).toBe('invulnerable');
    expect(sim.p('p0').targetId).not.toBe(solverId);
    expect(sim.p(sim.p('p0').targetId as string).status).toBe('alive');
  });

  it('with nobody stealable left you keep WATCHING a shielded player (steals are refused)', () => {
    const sim = new BrSim(3, { settings: { enableUnbeatableEarlyFinish: false } }).start();
    const others = ['p1', 'p2'];
    for (const id of others) sim.guess(id, sim.p(id).secret); // both shielded
    const watched = sim.p('p0').targetId as string;
    expect(others).toContain(watched);
    expect(sim.stealTarget('p0').rejections[0]?.reason).toBe('target_shielded');
  });
});

describe('battle royale — how a match ends', () => {
  it('last one standing wins; placings run winner → most recently out → first out', () => {
    const sim = new BrSim(3).start();
    const first = sim.p('p0').targetId as string;
    sim.stealTarget('p0');
    expect(sim.state.phase).toBe('PLAYING');
    sim.now += 1000;
    const second = sim.p('p0').targetId as string;
    sim.stealTarget('p0');
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.state.result).toMatchObject({ outcome: 'win', winnerId: 'p0', reason: 'stolen' });
    expect(sim.state.result?.standings).toEqual([
      { playerId: 'p0', place: 1 },
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
    sim.stealTarget('p0');
    sim.now += DEFAULT_SETTINGS.matchMs;
    sim.dispatch({ type: 'TICK' });
    expect(sim.state.phase).toBe('OVERTIME');
    for (const p of sim.state.players) {
      expect(p.rowLimit).toBe(p.status === 'alive' ? 9 : 6);
    }
  });

  it('a forfeit in a big match retargets the hunters and play continues', () => {
    const sim = new BrSim(5).start();
    const quitter = 'p2';
    const hunters = sim.state.players.filter((p) => p.targetId === quitter).map((p) => p.id);
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: quitter });
    sim.now += DEFAULT_SETTINGS.guestGraceMs;
    sim.dispatch({ type: 'TICK' });
    expect(sim.p(quitter)).toMatchObject({ status: 'eliminated', eliminationReason: 'forfeit' });
    expect(sim.state.phase).toBe('PLAYING');
    for (const h of hunters) expect(sim.p(h).targetId).not.toBe(quitter);
  });

  it('rematch drops players who left and starts with the rest', () => {
    const sim = new BrSim(4).start();
    sim.dispatch({ type: 'ABANDON' });
    sim.client({ type: 'RETURN_TO_LOBBY', playerId: 'p0' });
    sim.start();
    sim.stealTarget('p0');
    sim.stealTarget('p0');
    sim.stealTarget('p0');
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
    sim.stealTarget('p0');
    sim.stealTarget('p0');
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
    // Every one of the 100 players has their own shortlist of 3 — no two identical.
    expect(new Set(sim.state.players.map((p) => [...(p.targetOptions ?? [])].sort().join('|'))).size).toBe(100);
    for (const p of sim.state.players) expect(p.targetOptions).toHaveLength(3);

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
    expect(steals).toBeGreaterThan(20); // the match really was a battle royale, not a one-move finish
    expect(sim.state.players.filter((pl) => pl.status === 'eliminated').length).toBeGreaterThan(20);
    expect(ms).toBeLessThan(15_000); // the host referee keeps up comfortably
  });
});
