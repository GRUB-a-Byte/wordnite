import { describe, expect, it } from 'vitest';
import { findLeakedSessionSecrets, toPublicSession } from '../project';
import { createRng } from '../rng';
import { reduce } from '../reducer';
import { createSessionLobby, reduceSession } from '../session';
import { DEFAULT_SETTINGS, resolveSettings } from '../settings';
import type {
  ClientAction,
  EngineAction,
  GameSettings,
  PrivateDuel,
  PrivateSessionState,
  SessionPlayer,
  SessionReduceResult,
  WordDictionary,
} from '../types';
import { A, B, Sim, TEST_WORDS } from './helpers';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const ANSWERS = TEST_WORDS; // 30 words → plenty of distinct secrets for 16 players
const dictionary: WordDictionary = { isValid: (w) => TEST_WORDS.includes(w.toUpperCase()), answers: ANSWERS };

/** Drives the session referee like the HostRunner does. Players are p1 (host) … pN. */
class SessionSim {
  state: PrivateSessionState;
  now = 1_000_000;
  rng: () => number;
  last!: SessionReduceResult;
  private seqs = new Map<string, number>();

  constructor(n: number, opts: { settings?: Partial<GameSettings>; seed?: number } = {}) {
    const settings = resolveSettings({ maxPlayers: Math.max(2, n), ...opts.settings }, DEFAULT_SETTINGS);
    this.rng = createRng(opts.seed ?? 7);
    this.state = createSessionLobby({ roomCode: 'TEST', hostId: 'p1', hostNickname: 'p1', settings, now: this.now });
    for (let i = 2; i <= n; i++) {
      this.now += 1;
      this.dispatch({ type: 'PRESENCE_JOIN', playerId: `p${i}`, nickname: `p${i}`, role: 'player' });
    }
  }

  dispatch(action: EngineAction): SessionReduceResult {
    this.last = reduceSession(this.state, action, { now: this.now, rng: this.rng, dictionary });
    this.state = this.last.state;
    assertInvariants(this.state);
    return this.last;
  }

  client(action: DistributiveOmit<ClientAction, 'clientSeq'>): SessionReduceResult {
    const n = (this.seqs.get(action.playerId) ?? 0) + 1;
    this.seqs.set(action.playerId, n);
    return this.dispatch({ ...action, clientSeq: n } as ClientAction);
  }

  advance(ms: number): SessionReduceResult {
    this.now += ms;
    return this.dispatch({ type: 'TICK' });
  }

  start(): this {
    const res = this.client({ type: 'START', playerId: 'p1' });
    if (res.rejections.length) throw new Error(`START rejected: ${res.rejections[0]?.reason}`);
    return this;
  }

  /** START + skip every countdown → all first-round duels PLAYING. */
  startPlaying(): this {
    this.start();
    this.advance(this.state.settings.countdownMs);
    return this;
  }

  p(id: string): SessionPlayer {
    const p = this.state.players.find((x) => x.id === id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  duel(id: string | undefined): PrivateDuel {
    const d = this.state.duels.find((x) => x.id === id);
    if (!d) throw new Error(`no duel ${id}`);
    return d;
  }

  duelOf(playerId: string): PrivateDuel {
    return this.duel(this.p(playerId).duelId);
  }

  opponent(playerId: string): string {
    return this.duelOf(playerId).playerIds.find((x) => x !== playerId) as string;
  }

  secretOf(playerId: string): string {
    return this.duelOf(playerId).state.players.find((p) => p.id === playerId)!.secret;
  }

  guess(playerId: string, word: string): SessionReduceResult {
    return this.client({ type: 'GUESS', playerId, word });
  }

  /** `winner` steals the opponent's word → wins the duel immediately. */
  win(winner: string): SessionReduceResult {
    const loser = this.opponent(winner);
    return this.client({ type: 'STEAL', playerId: winner, targetId: loser, word: this.secretOf(loser) });
  }

  /** Runs a duel's clock out through overtime with nobody solving → draw. */
  drawDuelOf(playerId: string): void {
    const duel = this.duelOf(playerId);
    this.now = (duel.state.phaseEndsAt as number) + 1;
    this.dispatch({ type: 'TICK' });
    const ot = this.duel(duel.id);
    this.now = (ot.state.phaseEndsAt as number) + 1;
    this.dispatch({ type: 'TICK' });
  }

  byStatus(status: SessionPlayer['status']): string[] {
    return this.state.players.filter((p) => p.status === status).map((p) => p.id);
  }

  live(): PrivateDuel[] {
    return this.state.duels.filter((d) => ['COUNTDOWN', 'PLAYING', 'OVERTIME'].includes(d.state.phase));
  }
}

/** KH-3 / KH-10a invariants, checked after EVERY transition of every test. */
function assertInvariants(s: PrivateSessionState): void {
  if (s.phase !== 'IN_PROGRESS') return;
  const live = s.duels.filter((d) => ['COUNTDOWN', 'PLAYING', 'OVERTIME'].includes(d.state.phase));
  const seen = new Set<string>();
  for (const d of live) {
    expect(d.playerIds[0]).not.toBe(d.playerIds[1]);
    for (const id of d.playerIds) {
      expect(seen.has(id), `${id} is in two live duels`).toBe(false);
      seen.add(id);
      const p = s.players.find((x) => x.id === id)!;
      expect(p.status).toBe('dueling');
      expect(p.duelId).toBe(d.id);
    }
    // Symmetry: each duelist targets exactly the other one.
    const [x, y] = d.state.players;
    expect(x!.targetId).toBe(y!.id);
    expect(y!.targetId).toBe(x!.id);
  }
  expect(s.players.filter((p) => p.status === 'waiting').length).toBeLessThanOrEqual(1);
  for (const p of s.players) {
    if (p.status === 'dueling') expect(seen.has(p.id)).toBe(true);
  }
}

describe('KH-1 player cap', () => {
  it('defaults to 2; the host may set 2–16 in the lobby; 1 and 17 are rejected', () => {
    expect(DEFAULT_SETTINGS.maxPlayers).toBe(2);
    const sim = new SessionSim(2);
    expect(sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p1', patch: { maxPlayers: 16 } }).rejections).toEqual([]);
    expect(sim.state.settings.maxPlayers).toBe(16);
    for (const bad of [1, 17]) {
      expect(sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p1', patch: { maxPlayers: bad } }).rejections[0]?.reason).toBe(
        'invalid_settings',
      );
    }
    expect(sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p2', patch: { maxPlayers: 4 } }).rejections[0]?.reason).toBe('not_host');
  });

  it('joiners beyond the cap become would-be-player spectators and are promoted when the cap rises', () => {
    const sim = new SessionSim(2);
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'p3', nickname: 'p3', role: 'player' });
    expect(sim.state.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(sim.state.spectators[0]).toMatchObject({ id: 'p3', wantsToPlay: true });
    sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p1', patch: { maxPlayers: 3 } });
    expect(sim.state.players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(sim.state.spectators).toEqual([]);
  });

  it('E-30: lowering the cap demotes the most recent joiners (never the host)', () => {
    const sim = new SessionSim(5);
    sim.client({ type: 'UPDATE_SETTINGS', playerId: 'p1', patch: { maxPlayers: 3 } });
    expect(sim.state.players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(sim.state.spectators.map((s) => s.id).sort()).toEqual(['p4', 'p5']);
    expect(sim.state.spectators.every((s) => s.wantsToPlay && s.connected)).toBe(true);
  });

  it('E-31: someone who joins after START is a spectator until the next session', () => {
    const sim = new SessionSim(3).start();
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'late', nickname: 'late', role: 'player' });
    expect(sim.state.players.some((p) => p.id === 'late')).toBe(false);
    expect(sim.state.spectators.map((s) => s.id)).toEqual(['late']);
  });
});

describe('KH-2 / KH-3 start and pairing', () => {
  it('START needs ≥ 2 connected players', () => {
    const sim = new SessionSim(1);
    expect(sim.client({ type: 'START', playerId: 'p1' }).rejections[0]?.reason).toBe('not_enough_players');
  });

  it('pairing is symmetric and covers every seated player exactly once (N = 2…16, many seeds)', () => {
    for (let n = 2; n <= 16; n++) {
      for (let seed = 1; seed <= 12; seed++) {
        const sim = new SessionSim(n, { seed }).start();
        const inDuels = sim.state.duels.flatMap((d) => d.playerIds);
        const waiting = sim.byStatus('waiting');
        expect(sim.state.duels).toHaveLength(Math.floor(n / 2));
        expect(waiting).toHaveLength(n % 2);
        expect(new Set([...inDuels, ...waiting]).size).toBe(n);
        for (const d of sim.state.duels) {
          const [x, y] = d.state.players;
          expect(x!.targetId).toBe(y!.id);
          expect(y!.targetId).toBe(x!.id);
          expect(x!.secret).not.toBe(y!.secret); // GR-2
        }
      }
    }
  });

  it('odd count → exactly one random player waits; the same seed gives the same pairing (NFR-8)', () => {
    const waitingBySeed = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const a = new SessionSim(5, { seed }).start();
      const b = new SessionSim(5, { seed }).start();
      expect(a.state.duels.map((d) => d.playerIds)).toEqual(b.state.duels.map((d) => d.playerIds));
      expect(a.byStatus('waiting')).toEqual(b.byStatus('waiting'));
      waitingBySeed.add(a.byStatus('waiting')[0]!);
    }
    expect(waitingBySeed.size).toBeGreaterThan(2); // really random across seeds, not "last joiner"
  });

  it('secrets are unique across all live duels (KH-5 SHOULD)', () => {
    const sim = new SessionSim(16).start();
    const secrets = sim.state.duels.flatMap((d) => d.state.players.map((p) => p.secret));
    expect(new Set(secrets).size).toBe(16);
  });

  it('each duel runs its own countdown → 2:00 clock (KH-5)', () => {
    const sim = new SessionSim(4).start();
    for (const d of sim.state.duels) expect(d.state.phase).toBe('COUNTDOWN');
    sim.advance(DEFAULT_SETTINGS.countdownMs);
    for (const d of sim.state.duels) {
      expect(d.state.phase).toBe('PLAYING');
      expect(d.state.phaseEndsAt).toBe(sim.now + DEFAULT_SETTINGS.matchMs);
    }
  });
});

describe('KH-4 two boards only', () => {
  it('E-28: a steal at anyone but your current opponent is rejected invalid_target', () => {
    const sim = new SessionSim(4).startPlaying();
    const me = 'p1';
    const stranger = sim.state.players.find((p) => p.id !== me && p.id !== sim.opponent(me))!.id;
    const res = sim.client({ type: 'STEAL', playerId: me, targetId: stranger, word: sim.secretOf(stranger) });
    expect(res.rejections[0]?.reason).toBe('invalid_target');
    expect(sim.p(stranger).status).toBe('dueling');
  });

  it('E-27: an action carrying an old duelId is rejected stale_duel and uses no row', () => {
    const sim = new SessionSim(3, { settings: { resultBeatMs: 0 } }).startPlaying();
    const waiting = sim.byStatus('waiting')[0]!;
    const duelist = sim.state.players.find((p) => p.status === 'dueling')!.id;
    const oldDuel = sim.p(duelist).duelId!;
    sim.win(duelist); // beat 0 → paired with the waiting player at once
    expect(sim.opponent(duelist)).toBe(waiting);
    const res = sim.client({ type: 'GUESS', playerId: duelist, word: 'TOAST', duelId: oldDuel });
    expect(res.rejections[0]?.reason).toBe('stale_duel');
    expect(sim.duelOf(duelist).state.players.find((p) => p.id === duelist)!.rowsUsed).toBe(0);
  });

  it('a waiting player cannot act (not_in_duel)', () => {
    const sim = new SessionSim(3).startPlaying();
    const waiting = sim.byStatus('waiting')[0]!;
    expect(sim.client({ type: 'GUESS', playerId: waiting, word: 'TOAST' }).rejections[0]?.reason).toBe('not_in_duel');
  });
});

describe('KH-6 … KH-9 results and re-pairing', () => {
  it('KH-7/8: the winner becomes a hill-holder with streak 1; the loser is eliminated and ranked', () => {
    const sim = new SessionSim(4).startPlaying();
    const winner = 'p1';
    const loser = sim.opponent(winner);
    sim.win(winner);
    expect(sim.p(winner)).toMatchObject({ status: 'hill_holder', streak: 1 });
    expect(sim.p(winner).availableAt).toBe(sim.now + DEFAULT_SETTINGS.resultBeatMs);
    expect(sim.p(loser)).toMatchObject({ status: 'eliminated', eliminationReason: 'lost', rank: 4 });
    expect(sim.last.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['STEAL_HIT', 'FINISHED', 'DUEL_FINISHED', 'SESSION_ELIMINATED']),
    );
  });

  it('KH-9 / E-23: after the result beat the winner meets the waiting player in a FRESH duel', () => {
    const sim = new SessionSim(3).startPlaying();
    const waiting = sim.byStatus('waiting')[0]!;
    const winner = sim.state.duels[0]!.playerIds[0];
    const firstSecret = sim.secretOf(winner);
    sim.guess(winner, 'TOAST');
    sim.win(winner);
    expect(sim.p(waiting).status).toBe('waiting'); // beat not over yet
    sim.advance(DEFAULT_SETTINGS.resultBeatMs - 1);
    expect(sim.p(winner).status).toBe('hill_holder');
    sim.advance(1);
    expect(sim.p(winner)).toMatchObject({ status: 'dueling', streak: 1 });
    expect(sim.opponent(winner)).toBe(waiting);
    const fresh = sim.duelOf(winner).state;
    expect(fresh.phase).toBe('COUNTDOWN');
    const me = fresh.players.find((p) => p.id === winner)!;
    expect(me).toMatchObject({ rowsUsed: 0, rows: [], rowLimit: 6, status: 'alive', postSolveStealRows: 0 });
    expect(me.secret).not.toBe(firstSecret); // KH-6 new secrets
    expect(sim.last.events.map((e) => e.type)).toEqual(expect.arrayContaining(['PAIRED', 'MATCH_STARTED']));
  });

  it('KH-9: a winner with nobody waiting enters the waiting room after the beat', () => {
    const sim = new SessionSim(4).startPlaying();
    sim.win('p1');
    sim.advance(DEFAULT_SETTINGS.resultBeatMs);
    expect(sim.p('p1').status).toBe('waiting');
    expect(sim.last.events.map((e) => e.type)).toContain('WAITING');
  });

  it('E-22: two winners free at the same moment are paired with each other', () => {
    const sim = new SessionSim(4).startPlaying();
    const [d1, d2] = sim.state.duels;
    sim.win(d1!.playerIds[0]);
    sim.win(d2!.playerIds[1]);
    sim.advance(DEFAULT_SETTINGS.resultBeatMs);
    expect(sim.opponent(d1!.playerIds[0])).toBe(d2!.playerIds[1]);
    expect(sim.byStatus('waiting')).toEqual([]);
  });

  it('KH-8 / D-19: a duel draw eliminates both players with a shared rank', () => {
    const sim = new SessionSim(4).startPlaying();
    const [x, y] = sim.duelOf('p1').playerIds;
    const other = sim.state.duels.find((d) => !d.playerIds.includes('p1'))!;
    const w = other.playerIds[0];
    sim.win(w); // the other duel ends first (its loser ranks 4th)
    sim.drawDuelOf('p1');
    expect(sim.p(x).status).toBe('eliminated');
    expect(sim.p(y).status).toBe('eliminated');
    expect(sim.p(x).eliminationReason).toBe('draw');
    expect(sim.p(x).rank).toBe(2);
    expect(sim.p(y).rank).toBe(2);
    expect(sim.state.eliminationOrder).toEqual([[other.playerIds[1]], [x, y]]);
    expect(sim.state.result).toMatchObject({ outcome: 'champion', championId: w });
  });
});

describe('KH-10 session end', () => {
  it('last survivor is champion; standings run champion → reverse elimination order', () => {
    const sim = new SessionSim(4, { settings: { resultBeatMs: 0 } }).startPlaying();
    const [d1, d2] = sim.state.duels;
    const w1 = d1!.playerIds[0];
    const w2 = d2!.playerIds[0];
    sim.win(w1);
    sim.win(w2); // beat 0 → w1 v w2 immediately
    expect(sim.opponent(w1)).toBe(w2);
    sim.advance(DEFAULT_SETTINGS.countdownMs);
    sim.win(w2);
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.state.result).toMatchObject({ outcome: 'champion', championId: w2 });
    expect(sim.p(w2)).toMatchObject({ status: 'champion', rank: 1, streak: 2 });
    expect(sim.state.result!.standings.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    expect(sim.state.result!.standings[1]!.playerId).toBe(w1);
    expect(sim.state.finalDuelId).toBe(sim.p(w2).duelId);
  });

  it('E-24: A v B draw while C waits → C is champion', () => {
    const sim = new SessionSim(3).startPlaying();
    const waiting = sim.byStatus('waiting')[0]!;
    sim.drawDuelOf(sim.state.duels[0]!.playerIds[0]);
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.state.result).toMatchObject({ outcome: 'champion', championId: waiting });
  });

  it('E-25: the final two drawing ends the session as a draw', () => {
    const sim = new SessionSim(2).startPlaying();
    sim.drawDuelOf('p1');
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.state.result).toMatchObject({ outcome: 'draw' });
    expect(sim.state.result!.championId).toBeUndefined();
  });

  it('a sole survivor is crowned at once — never sent to the waiting room', () => {
    const sim = new SessionSim(3, { settings: { resultBeatMs: 0 } }).startPlaying();
    const duelist = sim.state.players.find((p) => p.status === 'dueling')!.id;
    sim.win(duelist);
    sim.advance(DEFAULT_SETTINGS.countdownMs);
    sim.win(duelist);
    expect(sim.state.phase).toBe('FINISHED');
    expect(sim.p(duelist).status).toBe('champion');
    expect(sim.last.events.map((e) => e.type)).not.toContain('WAITING');
  });

  it('property: random 3–16 player sessions always end with one champion or a draw, invariants hold throughout', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = createRng(seed * 31);
      const n = 3 + Math.floor(rng() * 14);
      const sim = new SessionSim(n, { seed, settings: { resultBeatMs: Math.floor(rng() * 3) * 1000 } }).start();
      for (let step = 0; step < 400 && sim.state.phase === 'IN_PROGRESS'; step++) {
        const playing = sim.live().filter((d) => d.state.phase === 'PLAYING' || d.state.phase === 'OVERTIME');
        if (playing.length && rng() < 0.8) {
          const d = playing[Math.floor(rng() * playing.length)]!;
          if (rng() < 0.85) sim.win(d.playerIds[Math.floor(rng() * 2)]!);
          else sim.drawDuelOf(d.playerIds[0]);
        } else {
          sim.advance(1000);
        }
      }
      expect(sim.state.phase, `seed ${seed}`).toBe('FINISHED');
      const champs = sim.byStatus('champion');
      expect(champs.length).toBeLessThanOrEqual(1);
      expect(sim.state.result!.outcome).toBe(champs.length ? 'champion' : 'draw');
      expect(sim.state.result!.standings).toHaveLength(n);
      expect(new Set(sim.state.eliminationOrder.flat()).size).toBe(n - champs.length);
    }
  });
});

describe('KH-11 / KH-12 disconnects and the host', () => {
  it('GR-35 inside a duel: the opponent of a player who stays away wins by forfeit', () => {
    const sim = new SessionSim(4).startPlaying();
    const leaver = sim.opponent('p1');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: leaver });
    sim.advance(DEFAULT_SETTINGS.guestGraceMs);
    expect(sim.p(leaver)).toMatchObject({ status: 'eliminated', eliminationReason: 'lost' });
    expect(sim.p('p1').status).toBe('hill_holder');
    expect(sim.duel(sim.p('p1').duelId).state.result).toMatchObject({ reason: 'forfeit', winnerId: 'p1' });
  });

  it('E-26: a waiting player disconnected for more than 15 s is eliminated (forfeit)', () => {
    // Pick a seed where the odd player out is a guest (the host never forfeits — GR-36 covers it).
    let seed = 1;
    while (new SessionSim(3, { seed }).start().byStatus('waiting')[0] === 'p1') seed++;
    const sim = new SessionSim(3, { seed }).startPlaying();
    const waiting = sim.byStatus('waiting')[0]!;
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: waiting });
    sim.advance(DEFAULT_SETTINGS.guestGraceMs - 1);
    expect(sim.p(waiting).status).toBe('waiting');
    sim.advance(1);
    expect(sim.p(waiting)).toMatchObject({ status: 'eliminated', eliminationReason: 'forfeit' });
    // The only duel's winner is then champion.
    const duelist = sim.state.duels[0]!.playerIds[0];
    sim.win(duelist);
    expect(sim.state.result).toMatchObject({ outcome: 'champion', championId: duelist });
  });

  it('a waiting player who comes back in time stays in the session', () => {
    let seed = 1;
    while (new SessionSim(3, { seed }).start().byStatus('waiting')[0] === 'p1') seed++;
    const sim = new SessionSim(3, { seed }).startPlaying();
    const waiting = sim.byStatus('waiting')[0]!;
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: waiting });
    sim.advance(5_000);
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: waiting, nickname: waiting, role: 'player' });
    sim.advance(DEFAULT_SETTINGS.guestGraceMs);
    expect(sim.p(waiting).status).toBe('waiting');
  });

  it('E-29: a knocked-out host keeps refereeing; other duels play on', () => {
    const sim = new SessionSim(4).startPlaying();
    const hostOpp = sim.opponent('p1');
    sim.win(hostOpp);
    expect(sim.p('p1').status).toBe('eliminated');
    const other = sim.state.duels.find((d) => !d.playerIds.includes('p1'))!;
    sim.win(other.playerIds[0]);
    sim.advance(DEFAULT_SETTINGS.resultBeatMs);
    expect(sim.opponent(hostOpp)).toBe(other.playerIds[0]);
  });

  it('KH-12: ABANDON ends every live duel and the session, revealing nothing', () => {
    const sim = new SessionSim(4).startPlaying();
    sim.dispatch({ type: 'ABANDON' });
    expect(sim.state.phase).toBe('ABANDONED');
    for (const d of sim.state.duels) expect(d.state.phase).toBe('ABANDONED');
    const pub = toPublicSession(sim.state, sim.now);
    for (const d of pub.duels) expect(d.revealedSecrets).toBeUndefined();
  });
});

describe('KH-13 new session', () => {
  it('reshuffles every connected player (eliminated ones included) and seats late joiners', () => {
    const sim = new SessionSim(3, { settings: { maxPlayers: 4 } }).startPlaying();
    sim.dispatch({ type: 'PRESENCE_JOIN', playerId: 'late', nickname: 'late', role: 'player' });
    sim.drawDuelOf(sim.state.duels[0]!.playerIds[0]);
    expect(sim.state.phase).toBe('FINISHED');
    const res = sim.client({ type: 'NEW_SESSION', playerId: 'p1' });
    expect(res.rejections).toEqual([]);
    expect(sim.state.phase).toBe('IN_PROGRESS');
    expect(sim.state.sessionNumber).toBe(2);
    expect(sim.state.players.map((p) => p.id).sort()).toEqual(['late', 'p1', 'p2', 'p3']);
    expect(sim.state.players.every((p) => p.streak === 0 && p.status === 'dueling')).toBe(true);
  });

  it('REMATCH is accepted as an alias; only the host may start a new session', () => {
    const sim = new SessionSim(2).startPlaying();
    sim.win('p1');
    expect(sim.client({ type: 'REMATCH', playerId: 'p2' }).rejections[0]?.reason).toBe('not_host');
    expect(sim.client({ type: 'REMATCH', playerId: 'p1' }).rejections).toEqual([]);
    expect(sim.state.phase).toBe('IN_PROGRESS');
  });

  it('rejects without side effects when fewer than 2 connected players remain', () => {
    const sim = new SessionSim(2).startPlaying();
    sim.win('p1');
    sim.dispatch({ type: 'PRESENCE_LEAVE', playerId: 'p2' });
    const before = sim.state.players.length;
    expect(sim.client({ type: 'NEW_SESSION', playerId: 'p1' }).rejections[0]?.reason).toBe('not_enough_players');
    expect(sim.state.players.length).toBe(before);
    expect(sim.state.phase).toBe('FINISHED');
  });
});

describe('KH-14 two-player equivalence with 1.0', () => {
  /** Runs the same scripted match through the 1.0 reducer and through a 2-player session. */
  function both(script: (act: (who: 'A' | 'B', a: { type: 'GUESS' | 'STEAL'; word: string }) => void, wait: (ms: number) => void) => void) {
    const dict2: WordDictionary = { isValid: dictionary.isValid, answers: ['CRANE', 'SLATE'] };
    const duel = new Sim();
    const session = { state: createSessionLobby({ roomCode: 'TEST', hostId: A, hostNickname: 'alice', settings: { ...DEFAULT_SETTINGS }, now: duel.now }), seq: new Map<string, number>() };
    const ctx = (now: number) => ({ now, rng: () => 0, dictionary: dict2 });
    const send = (a: EngineAction) => {
      session.state = reduceSession(session.state, a, ctx(duel.now)).state;
    };
    send({ type: 'PRESENCE_JOIN', playerId: B, nickname: 'bob', role: 'player' });
    duel.client({ type: 'START', playerId: A });
    send({ type: 'START', playerId: A, clientSeq: 1 });
    session.seq.set(A, 1);
    const act = (who: 'A' | 'B', a: { type: 'GUESS' | 'STEAL'; word: string }) => {
      const id = who === 'A' ? A : B;
      const target = who === 'A' ? B : A;
      if (a.type === 'GUESS') duel.guess(id, a.word);
      else duel.steal(id, a.word, target);
      const n = (session.seq.get(id) ?? 0) + 1;
      session.seq.set(id, n);
      send(a.type === 'GUESS' ? { type: 'GUESS', playerId: id, word: a.word, clientSeq: n } : { type: 'STEAL', playerId: id, targetId: target, word: a.word, clientSeq: n });
    };
    const wait = (ms: number) => {
      duel.advance(ms);
      send({ type: 'TICK' });
    };
    wait(DEFAULT_SETTINGS.countdownMs);
    script(act, wait);
    return { duel: duel.state, session: session.state };
  }

  const strip = (s: ReturnType<typeof both>['duel']) => ({
    phase: s.phase,
    result: s.result,
    players: s.players.map((p) => ({ ...p, lastSeq: 0 })),
    overtimeUsed: s.overtimeUsed,
  });

  it('a steal win, a solve race and an overtime draw produce identical duel state', () => {
    const scripts = [
      (act: Parameters<Parameters<typeof both>[0]>[0]) => {
        act('A', { type: 'GUESS', word: 'TRAIN' });
        act('B', { type: 'STEAL', word: 'GHOST' });
        act('A', { type: 'STEAL', word: 'SLATE' });
      },
      (act: Parameters<Parameters<typeof both>[0]>[0]) => {
        act('A', { type: 'GUESS', word: 'TRAIN' });
        act('A', { type: 'GUESS', word: 'CRANE' });
        act('B', { type: 'GUESS', word: 'SLATE' });
      },
      (_act: Parameters<Parameters<typeof both>[0]>[0], wait: (ms: number) => void) => {
        wait(DEFAULT_SETTINGS.matchMs);
        wait(DEFAULT_SETTINGS.overtimeMs);
      },
    ];
    for (const script of scripts) {
      const { duel, session } = both(script);
      const only = session.duels[0]!.state;
      expect(session.duels).toHaveLength(1);
      expect(strip(only)).toEqual(strip(duel));
      expect(session.phase).toBe('FINISHED');
      if (duel.result?.outcome === 'win') expect(session.result?.championId).toBe(duel.result.winnerId);
      else expect(session.result?.outcome).toBe('draw');
    }
  });

  it('2 players are paired host-first without drawing from the RNG', () => {
    const sim = new SessionSim(2).start();
    expect(sim.state.duels[0]!.playerIds).toEqual(['p1', 'p2']);
    // rng=0 picks the first answers in order, exactly as the 1.0 START does.
    const direct = reduce(
      sim.state.duels[0]!.state,
      { type: 'TICK' },
      { now: sim.now, rng: () => 0, dictionary },
    ).state;
    expect(direct.players.map((p) => p.targetId)).toEqual(['p2', 'p1']);
  });
});

describe('FIX 1 for sessions: projection', () => {
  it('no active secret is ever in a session snapshot, through a whole 5-player session', () => {
    const sim = new SessionSim(5, { settings: { resultBeatMs: 1000 } }).startPlaying();
    const check = () => {
      const pub = toPublicSession(sim.state, sim.now);
      expect(findLeakedSessionSecrets(sim.state, pub)).toEqual([]);
      const json = JSON.stringify(pub);
      expect(json).not.toContain('"secret"');
      for (const d of sim.live()) {
        for (const p of d.state.players) if (p.status === 'alive') expect(json).not.toContain(`"${p.secret}"`);
      }
    };
    for (let i = 0; i < 20 && sim.state.phase === 'IN_PROGRESS'; i++) {
      check();
      const d = sim.live().find((x) => x.state.phase === 'PLAYING');
      if (d) {
        sim.guess(d.playerIds[0], 'TOAST');
        check();
        sim.win(d.playerIds[1]);
      } else sim.advance(1000);
    }
    check();
    expect(sim.state.phase).toBe('FINISHED');
  });

  it('the tripwire catches a leak', () => {
    const sim = new SessionSim(4).startPlaying();
    const pub = toPublicSession(sim.state, sim.now);
    (pub as unknown as { debug: string }).debug = sim.secretOf('p1');
    expect(findLeakedSessionSecrets(sim.state, pub)).toEqual([sim.secretOf('p1')]);
  });

  it('finished duels reveal their secrets, and old finished duels drop out of snapshots', () => {
    const sim = new SessionSim(4).startPlaying();
    const loser = sim.opponent('p1');
    const loserSecret = sim.secretOf(loser);
    const duelId = sim.p('p1').duelId!;
    sim.win('p1');
    let pub = toPublicSession(sim.state, sim.now);
    expect(pub.duels.find((d) => d.id === duelId)?.revealedSecrets?.[loser]).toBe(loserSecret);
    sim.advance(DEFAULT_SETTINGS.resultBeatMs + 60_000);
    pub = toPublicSession(sim.state, sim.now);
    expect(pub.duels.some((d) => d.id === duelId)).toBe(false);
  });

  it('16-player snapshot stays within the 32 KB budget mid-session', () => {
    const sim = new SessionSim(16).startPlaying();
    for (const d of sim.live()) {
      for (const id of d.playerIds) {
        for (const w of ['TOAST', 'PRISM', 'UNCLE', 'ZEBRA', 'KNIFE']) {
          if (w !== sim.secretOf(id) && w !== sim.secretOf(sim.opponent(id))) sim.guess(id, w);
        }
      }
    }
    const bytes = JSON.stringify(toPublicSession(sim.state, sim.now)).length;
    expect(bytes).toBeLessThan(32 * 1024);
  });
});
