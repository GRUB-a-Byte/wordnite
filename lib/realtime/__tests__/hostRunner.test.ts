import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/engine/settings';
import type { PublicDuel, PublicSessionState, Rejection } from '@/lib/engine/types';
import { testDictionary } from '@/lib/engine/__tests__/helpers';
import { beatKey, HostRunner, stateKey } from '../hostRunner';
import type { EventName, EventPayloads, PresenceMeta } from '../protocol';
import type { RoomTransport, TransportStatus } from '../transport';

/** In-memory transport: records outbound messages and lets tests inject inbound ones. */
class FakeTransport implements RoomTransport {
  readonly kind = 'local' as const;
  status: TransportStatus = 'connected';
  sent: { event: EventName; payload: unknown }[] = [];
  private handlers = new Map<string, ((p: unknown) => void)[]>();
  private presenceHandlers: ((m: PresenceMeta[]) => void)[] = [];
  private statusHandlers: ((s: TransportStatus) => void)[] = [];

  send<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    this.sent.push({ event, payload: structuredClone(payload) });
  }
  on<E extends EventName>(event: E, h: (p: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
    return () => {};
  }
  onPresence(h: (m: PresenceMeta[]) => void) {
    this.presenceHandlers.push(h);
    return () => {};
  }
  onStatus(h: (s: TransportStatus) => void) {
    this.statusHandlers.push(h);
    return () => {};
  }
  track(): void {}
  close(): void {}

  deliver(event: EventName, payload: unknown) {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }
  presence(members: PresenceMeta[]) {
    this.presenceHandlers.forEach((h) => h(members));
  }
  setStatus(s: TransportStatus) {
    this.status = s;
    this.statusHandlers.forEach((h) => h(s));
  }
  states(): PublicSessionState[] {
    return this.sent.filter((m) => m.event === 'state').map((m) => m.payload as PublicSessionState);
  }
  lastState(): PublicSessionState {
    return this.states().at(-1)!;
  }
  /** The (single) duel of a 2-player session. */
  lastDuel(): PublicDuel {
    return this.lastState().duels.at(-1)!;
  }
  rejects(): Rejection[] {
    return this.sent.filter((m) => m.event === 'reject').map((m) => m.payload as Rejection);
  }
}

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const HOST = 'hosty';
const GUEST = 'guesty';
const member = (playerId: string, role: PresenceMeta['role'], nickname = playerId): PresenceMeta => ({
  playerId,
  nickname,
  role,
  joinedAt: 1,
});

describe('HostRunner (FIX 7: host-referee reliability)', () => {
  let now: number;
  let transport: FakeTransport;
  let storage: MemoryStorage;
  let applied: PublicSessionState[];

  const makeRunner = () =>
    new HostRunner({
      transport,
      roomCode: 'ABCD',
      hostId: HOST,
      hostNickname: 'alice',
      settings: { ...DEFAULT_SETTINGS },
      dictionary: testDictionary(['CRANE', 'SLATE']),
      rng: () => 0,
      storage,
      now: () => now,
      onPublicState: (s) => applied.push(s),
      tickMs: 250,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    transport = new FakeTransport();
    storage = new MemoryStorage();
    applied = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function startMatch(runner: HostRunner) {
    transport.presence([member(HOST, 'host'), member(GUEST, 'player', 'bob')]);
    transport.deliver('action', { type: 'START', playerId: HOST, clientSeq: 1 });
    now += DEFAULT_SETTINGS.countdownMs;
    runner.dispatch({ type: 'TICK' });
  }

  it('broadcasts an initial lobby snapshot and applies it locally', () => {
    const runner = makeRunner();
    runner.start();
    expect(transport.lastState().phase).toBe('LOBBY');
    expect(applied.at(-1)?.version).toBe(transport.lastState().version);
    runner.stop();
  });

  it('presence joins become lobby players; leaves are diffed against the roster', () => {
    const runner = makeRunner();
    runner.start();
    transport.presence([member(HOST, 'host'), member(GUEST, 'player', 'bob'), member('watcher', 'spectator')]);
    expect(transport.lastState().players.map((p) => p.id)).toEqual([HOST, GUEST]);
    expect(transport.lastState().spectators.map((s) => s.id)).toEqual(['watcher']);
    transport.presence([member(HOST, 'host')]);
    expect(transport.lastState().players.map((p) => p.id)).toEqual([HOST]);
    expect(transport.lastState().spectators).toEqual([]);
    runner.stop();
  });

  it('never broadcasts an active secret (FIX 1) — through a full match', () => {
    const runner = makeRunner();
    runner.start();
    startMatch(runner);
    transport.deliver('action', { type: 'GUESS', playerId: GUEST, word: 'TRAIN', clientSeq: 1 });
    transport.deliver('action', { type: 'STEAL', playerId: HOST, targetId: GUEST, word: 'GHOST', clientSeq: 2 });
    for (const s of transport.states()) {
      const json = JSON.stringify(s);
      expect(json).not.toContain('"secret"');
      if (s.phase !== 'FINISHED') {
        expect(json).not.toContain('"CRANE"');
        expect(json).not.toContain('"SLATE"');
      }
    }
    transport.deliver('action', { type: 'STEAL', playerId: HOST, targetId: GUEST, word: 'SLATE', clientSeq: 3 });
    expect(transport.lastState().phase).toBe('FINISHED');
    expect(transport.lastDuel().revealedSecrets).toEqual({ [HOST]: 'CRANE', [GUEST]: 'SLATE' });
    expect(transport.lastState().result).toMatchObject({ outcome: 'champion', championId: HOST });
    runner.stop();
  });

  it('broadcasts rejections to the channel, and resends state (not a reject) for duplicate seqs', () => {
    const runner = makeRunner();
    runner.start();
    startMatch(runner);
    transport.deliver('action', { type: 'GUESS', playerId: GUEST, word: 'ZZZZZ', clientSeq: 1 });
    expect(transport.rejects()).toEqual([{ playerId: GUEST, clientSeq: 1, reason: 'invalid_word' }]);
    const statesBefore = transport.states().length;
    transport.deliver('action', { type: 'GUESS', playerId: GUEST, word: 'TRAIN', clientSeq: 1 });
    expect(transport.rejects()).toHaveLength(1);
    expect(transport.states().length).toBe(statesBefore + 1); // resync snapshot = ack
    expect(transport.lastDuel().players.find((p) => p.id === GUEST)?.rowsUsed).toBe(0);
    runner.stop();
  });

  it('ignores malformed / hostile action payloads', () => {
    const runner = makeRunner();
    runner.start();
    startMatch(runner);
    const v = transport.lastState().version;
    for (const junk of [null, 42, 'GUESS', { type: 'GUESS' }, { type: 'NUKE', playerId: GUEST, clientSeq: 9 }, { type: 'GUESS', playerId: GUEST, clientSeq: -1, word: 'TRAIN' }, { type: 'GUESS', playerId: GUEST, clientSeq: 2, word: { evil: true } }]) {
      transport.deliver('action', junk);
    }
    expect(transport.lastState().version).toBe(v);
    expect(transport.rejects()).toEqual([]);
    runner.stop();
  });

  it('processes actions strictly in arrival order (FIFO): first successful steal wins', () => {
    const runner = makeRunner();
    runner.start();
    startMatch(runner);
    transport.deliver('action', { type: 'STEAL', playerId: GUEST, targetId: HOST, word: 'CRANE', clientSeq: 1 });
    transport.deliver('action', { type: 'STEAL', playerId: HOST, targetId: GUEST, word: 'SLATE', clientSeq: 2 });
    expect(transport.lastDuel().result).toMatchObject({ winnerId: GUEST, reason: 'stolen' });
    expect(transport.rejects()).toEqual([{ playerId: HOST, clientSeq: 2, reason: 'not_playing' }]);
    runner.stop();
  });

  it('runs the clock on its own tick interval (countdown → playing → overtime)', () => {
    const runner = makeRunner();
    runner.start();
    transport.presence([member(HOST, 'host'), member(GUEST, 'player')]);
    transport.deliver('action', { type: 'START', playerId: HOST, clientSeq: 1 });
    now += DEFAULT_SETTINGS.countdownMs;
    vi.advanceTimersByTime(300);
    expect(transport.lastDuel().phase).toBe('PLAYING');
    now += DEFAULT_SETTINGS.matchMs;
    vi.advanceTimersByTime(300);
    expect(transport.lastDuel().phase).toBe('OVERTIME');
    runner.stop();
  });

  it('a guest who leaves mid-match forfeits after the grace period (GR-35)', () => {
    const runner = makeRunner();
    runner.start();
    startMatch(runner);
    transport.presence([member(HOST, 'host')]);
    expect(transport.lastState().players.find((p) => p.id === GUEST)?.connected).toBe(false);
    now += DEFAULT_SETTINGS.guestGraceMs;
    vi.advanceTimersByTime(300);
    expect(transport.lastDuel().result).toMatchObject({ winnerId: HOST, reason: 'forfeit' });
    runner.stop();
  });

  it('persists state + heartbeat and restores them after a host refresh (E-15)', () => {
    const r1 = makeRunner();
    r1.start();
    startMatch(r1);
    transport.deliver('action', { type: 'GUESS', playerId: GUEST, word: 'TRAIN', clientSeq: 1 });
    vi.advanceTimersByTime(1100); // heartbeat
    r1.stop();
    expect(storage.getItem(stateKey('ABCD'))).toBeTruthy();
    expect(Number(storage.getItem(beatKey('ABCD')))).toBe(now);

    now += 2_000; // quick refresh
    const r2 = makeRunner();
    expect(r2.restored).toBe(true);
    r2.start();
    expect(r2.privateState.phase).toBe('IN_PROGRESS');
    const duel = r2.privateState.duels[0]!.state;
    expect(duel.phase).toBe('PLAYING');
    expect(duel.players.find((p) => p.id === GUEST)?.rowsUsed).toBe(1);
    expect(r2.secretsByPlayer()).toEqual({ [HOST]: 'CRANE', [GUEST]: 'SLATE' });
    r2.stop();
  });

  it('a host that comes back after more than hostGraceMs finds the match abandoned (GR-36)', () => {
    const r1 = makeRunner();
    r1.start();
    startMatch(r1);
    vi.advanceTimersByTime(1100);
    r1.stop();
    now += DEFAULT_SETTINGS.hostGraceMs + 1;
    const r2 = makeRunner();
    r2.start();
    expect(r2.privateState.phase).toBe('ABANDONED');
    expect(transport.lastState().result).toEqual({ outcome: 'abandoned', standings: [] });
    expect(r2.privateState.duels[0]!.state.result).toEqual({ outcome: 'abandoned', reason: 'abandoned' });
    expect(transport.lastState().duels).toEqual([]); // abandoned duels are not broadcast (nothing revealed)
    r2.stop();
  });

  it('a host whose own connection is down for more than hostGraceMs abandons the match (GR-36)', () => {
    const runner = makeRunner();
    runner.start();
    startMatch(runner);
    transport.setStatus('reconnecting');
    now += DEFAULT_SETTINGS.hostGraceMs - 1000;
    vi.advanceTimersByTime(300);
    expect(runner.privateState.phase).toBe('IN_PROGRESS');
    now += 2000;
    vi.advanceTimersByTime(300);
    expect(runner.privateState.phase).toBe('ABANDONED');
    runner.stop();
  });

  it('v1.1: three players — one waits, the duel winner meets them after the result beat, a champion is crowned', () => {
    const runner = new HostRunner({
      transport,
      roomCode: 'ABCD',
      hostId: HOST,
      hostNickname: 'alice',
      settings: { ...DEFAULT_SETTINGS, maxPlayers: 3 },
      dictionary: testDictionary(['CRANE', 'SLATE', 'TRAIN', 'GHOST', 'PLUMB']),
      rng: () => 0.5,
      storage,
      now: () => now,
      onPublicState: (s) => applied.push(s),
      tickMs: 250,
    });
    runner.start();
    transport.presence([member(HOST, 'host'), member(GUEST, 'player', 'bob'), member('third', 'player', 'cat')]);
    transport.deliver('action', { type: 'START', playerId: HOST, clientSeq: 1 });
    let pub = transport.lastState();
    expect(pub.duels).toHaveLength(1);
    const waiting = pub.players.find((p) => p.status === 'waiting')!;
    expect(waiting).toBeDefined();
    const [x, y] = pub.duels[0]!.playerIds;
    now += DEFAULT_SETTINGS.countdownMs;
    vi.advanceTimersByTime(300);
    const secrets = runner.secretsByPlayer();
    transport.deliver('action', { type: 'STEAL', playerId: x, targetId: y, word: secrets[y], clientSeq: 2 });
    pub = transport.lastState();
    expect(pub.players.find((p) => p.id === x)).toMatchObject({ status: 'hill_holder', streak: 1 });
    expect(pub.players.find((p) => p.id === y)).toMatchObject({ status: 'eliminated' });
    now += DEFAULT_SETTINGS.resultBeatMs;
    vi.advanceTimersByTime(300);
    pub = transport.lastState();
    const second = pub.duels.find((d) => d.phase === 'COUNTDOWN')!;
    expect([...second.playerIds].sort()).toEqual([x, waiting.id].sort());
    now += DEFAULT_SETTINGS.countdownMs;
    vi.advanceTimersByTime(300);
    const s2 = runner.secretsByPlayer();
    transport.deliver('action', { type: 'STEAL', playerId: waiting.id, targetId: x, word: s2[x], clientSeq: 1 });
    pub = transport.lastState();
    expect(pub.phase).toBe('FINISHED');
    expect(pub.result).toMatchObject({ outcome: 'champion', championId: waiting.id });
    for (const st of transport.states()) {
      // No snapshot ever carried a live duel's secret.
      for (const d of st.duels) if (d.phase !== 'FINISHED') expect(d.revealedSecrets).toBeUndefined();
    }
    runner.stop();
  });

  it('answers sync_request with a fresh snapshot (guest reconnect, NFR-6)', () => {
    const runner = makeRunner();
    runner.start();
    const n = transport.states().length;
    transport.deliver('sync_request', { playerId: GUEST });
    transport.deliver('sync_request', { playerId: GUEST });
    vi.advanceTimersByTime(60);
    expect(transport.states().length).toBe(n + 1); // bursts are coalesced
    runner.stop();
  });
});
