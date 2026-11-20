import { describe, expect, it } from 'vitest';
import { findLeakedSecrets, toPublicState } from '../project';
import { A, B, Sim } from './helpers';

/** FIX 1 — the public projection must never carry an active secret. */
describe('toPublicState (secret redaction)', () => {
  const allPublicJson = (sim: Sim) => JSON.stringify(toPublicState(sim.state, sim.now));

  it('lobby / countdown / playing snapshots contain no secret field and neither secret word', () => {
    const sim = new Sim();
    expect(allPublicJson(sim)).not.toMatch(/"secret"/);
    sim.client({ type: 'START', playerId: A });
    const pubCountdown = toPublicState(sim.state, sim.now);
    expect(JSON.stringify(pubCountdown)).not.toMatch(/"secret"/);
    expect(JSON.stringify(pubCountdown)).not.toContain('CRANE');
    expect(JSON.stringify(pubCountdown)).not.toContain('SLATE');
    sim.advance(3_000);
    sim.guess(A, 'TRAIN');
    sim.steal(B, 'GHOST');
    const pub = toPublicState(sim.state, sim.now);
    expect(pub.revealedSecrets).toBeUndefined();
    for (const p of pub.players) expect(p).not.toHaveProperty('secret');
    expect(JSON.stringify(pub)).not.toContain('CRANE');
    expect(JSON.stringify(pub)).not.toContain('SLATE');
    expect(findLeakedSecrets(sim.state, pub)).toEqual([]);
  });

  it('after a solve, only the SOLVED (no longer stealable) word appears — on the solver’s own row', () => {
    const sim = new Sim({ settings: { enableUnbeatableEarlyFinish: false } }).startPlaying();
    sim.guess(A, 'CRANE');
    const json = allPublicJson(sim);
    expect(json).toContain('CRANE'); // A's own solved row (A is invulnerable; GR-6 shows all rows)
    expect(json).not.toContain('SLATE'); // B is alive → B's secret stays hidden
    expect(findLeakedSecrets(sim.state, toPublicState(sim.state, sim.now))).toEqual([]);
  });

  it('secrets are revealed only once FINISHED (FR-6.2)', () => {
    const sim = new Sim().startPlaying();
    sim.steal(A, 'SLATE');
    const pub = toPublicState(sim.state, sim.now);
    expect(pub.phase).toBe('FINISHED');
    expect(pub.revealedSecrets).toEqual({ [A]: 'CRANE', [B]: 'SLATE' });
  });

  it('abandoned matches do not reveal secrets', () => {
    const sim = new Sim().startPlaying();
    sim.dispatch({ type: 'ABANDON' });
    const pub = toPublicState(sim.state, sim.now);
    expect(pub.revealedSecrets).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('CRANE');
  });

  it('referee-only counters are not projected; hostNow is stamped', () => {
    const sim = new Sim().startPlaying();
    const pub = toPublicState(sim.state, 123);
    expect(pub).not.toHaveProperty('rowCounter');
    expect(pub).not.toHaveProperty('eventCounter');
    expect(pub.hostNow).toBe(123);
  });

  it('the projection is a deep copy (mutating it cannot corrupt the referee state)', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'TRAIN');
    const pub = toPublicState(sim.state, sim.now);
    pub.players[0]!.rows[0]!.tiles[0] = 'correct';
    pub.settings.baseRows = 99;
    expect(sim.p(A).rows[0]!.tiles[0]).toBe('absent');
    expect(sim.state.settings.baseRows).toBe(6);
  });

  it('no false positive when a player types the opponent’s word as an OWN guess', () => {
    const sim = new Sim().startPlaying();
    sim.guess(A, 'SLATE'); // B's secret, but scored against A's CRANE — B is still alive
    expect(sim.p(B).status).toBe('alive');
    expect(findLeakedSecrets(sim.state, toPublicState(sim.state, sim.now))).toEqual([]);
  });

  it('findLeakedSecrets catches a leak', () => {
    const sim = new Sim().startPlaying();
    const pub = toPublicState(sim.state, sim.now);
    (pub as unknown as { debug: string }).debug = 'SLATE';
    expect(findLeakedSecrets(sim.state, pub)).toEqual(['SLATE']);
  });
});
