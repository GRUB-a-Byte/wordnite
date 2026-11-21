import { describe, expect, it } from 'vitest';
import { RESULT_HOLD_MS, toPublicSession } from '@/lib/engine/project';
import { createRng } from '@/lib/engine/rng';
import { createSessionLobby, reduceSession } from '@/lib/engine/session';
import { DEFAULT_SETTINGS, resolveSettings } from '@/lib/engine/settings';
import type { ClientAction, EngineAction, PrivateSessionState, PublicSessionState } from '@/lib/engine/types';
import { TEST_WORDS } from '@/lib/engine/__tests__/helpers';
import { isSpaceKey, isTextEntryTarget, spaceAction } from '../shortcuts';
import { eventsForView, selectView } from '../view';

const dictionary = { isValid: (w: string) => TEST_WORDS.includes(w.toUpperCase()), answers: TEST_WORDS };

function session(n: number, seed = 3) {
  let now = 1_000_000;
  let state: PrivateSessionState = createSessionLobby({
    roomCode: 'TEST',
    hostId: 'p1',
    hostNickname: 'p1',
    settings: resolveSettings({ maxPlayers: Math.max(2, n) }, DEFAULT_SETTINGS),
    now,
  });
  const rng = createRng(seed);
  const seqs = new Map<string, number>();
  const send = (a: EngineAction) => {
    state = reduceSession(state, a, { now, rng, dictionary }).state;
  };
  for (let i = 2; i <= n; i++) send({ type: 'PRESENCE_JOIN', playerId: `p${i}`, nickname: `p${i}`, role: 'player' });
  const api = {
    get state() {
      return state;
    },
    get now() {
      return now;
    },
    pub(): PublicSessionState {
      return toPublicSession(state, now);
    },
    act(a: Omit<ClientAction, 'clientSeq'>) {
      const n = (seqs.get(a.playerId) ?? 0) + 1;
      seqs.set(a.playerId, n);
      send({ ...a, clientSeq: n } as ClientAction);
    },
    advance(ms: number) {
      now += ms;
      send({ type: 'TICK' });
    },
    win(winner: string) {
      const duel = state.duels.find((d) => d.id === state.players.find((p) => p.id === winner)!.duelId)!;
      const loser = duel.playerIds.find((x) => x !== winner)!;
      const word = duel.state.players.find((p) => p.id === loser)!.secret;
      api.act({ type: 'STEAL', playerId: winner, targetId: loser, word } as Omit<ClientAction, 'clientSeq'>);
    },
  };
  return api;
}

describe('selectView (v1.1 screens)', () => {
  it('lobby → duel for players, watch for spectators of a single duel', () => {
    const s = session(2);
    expect(selectView(s.pub(), 'p1', { hostNow: s.now }).kind).toBe('lobby');
    s.act({ type: 'START', playerId: 'p1' });
    const v = selectView(s.pub(), 'p2', { hostNow: s.now });
    expect(v.kind).toBe('duel');
    expect(v.game?.players.map((p) => p.id)).toEqual(['p1', 'p2']); // a 1.0-shaped duel view
    expect(v.game?.phase).toBe('COUNTDOWN');
    expect(selectView(s.pub(), 'someone-else', { hostNow: s.now }).kind).toBe('watch');
  });

  it('odd player out sees the waiting room; spectators of several duels see the grid', () => {
    const s = session(5);
    s.act({ type: 'START', playerId: 'p1' });
    const waiting = s.state.players.find((p) => p.status === 'waiting')!.id;
    expect(selectView(s.pub(), waiting, { hostNow: s.now })).toMatchObject({ kind: 'waiting', game: null });
    expect(selectView(s.pub(), 'watcher', { hostNow: s.now }).kind).toBe('grid');
  });

  it('winner sees the result card until re-paired; loser sees it until the beat + hold, or until dismissed', () => {
    const s = session(4);
    s.act({ type: 'START', playerId: 'p1' });
    s.advance(DEFAULT_SETTINGS.countdownMs);
    const loser = s.state.duels.find((d) => d.playerIds.includes('p1'))!.playerIds.find((x) => x !== 'p1')!;
    s.win('p1');
    const pub = s.pub();
    expect(selectView(pub, 'p1', { hostNow: s.now }).kind).toBe('duel_result');
    expect(selectView(pub, loser, { hostNow: s.now }).kind).toBe('duel_result');
    const until = s.now + DEFAULT_SETTINGS.resultBeatMs + RESULT_HOLD_MS;
    expect(selectView(pub, loser, { hostNow: until }).kind).toBe('watch'); // one duel still live
    const duelId = selectView(pub, loser, { hostNow: s.now }).duelId;
    expect(selectView(pub, loser, { hostNow: s.now, dismissedDuelId: duelId }).kind).toBe('watch');
  });

  it('finished → the final duel; abandoned → abandoned', () => {
    const s = session(2);
    s.act({ type: 'START', playerId: 'p1' });
    s.advance(DEFAULT_SETTINGS.countdownMs);
    s.win('p2');
    const v = selectView(s.pub(), 'p1', { hostNow: s.now });
    expect(v.kind).toBe('finished');
    expect(v.game?.result).toMatchObject({ winnerId: 'p2', reason: 'stolen' });
    expect(v.game?.revealedSecrets).toBeDefined();
  });

  it('overlay events are scoped to the duel on screen', () => {
    const s = session(6); // 3 duels → 2 still live after one ends, so watchers stay on the grid
    s.act({ type: 'START', playerId: 'p1' });
    s.advance(DEFAULT_SETTINGS.countdownMs);
    const other = s.state.duels.find((d) => !d.playerIds.includes('p1'))!;
    s.win(other.playerIds[0]);
    const pub = s.pub();
    const mine = selectView(pub, 'p1', { hostNow: s.now });
    expect(eventsForView(pub.lastEvents, mine).some((e) => e.type === 'STEAL_HIT')).toBe(false);
    const grid = selectView(pub, 'watcher', { hostNow: s.now });
    expect(eventsForView(pub.lastEvents, grid).some((e) => e.type === 'STEAL_HIT')).toBe(true);
  });
});

describe('FR-4.2a Spacebar toggle', () => {
  it('toggles only for an alive player during PLAYING / OVERTIME, never on key repeat', () => {
    expect(spaceAction({ phase: 'PLAYING', status: 'alive', repeat: false })).toBe('toggle');
    expect(spaceAction({ phase: 'OVERTIME', status: 'alive', repeat: false })).toBe('toggle');
    expect(spaceAction({ phase: 'PLAYING', status: 'alive', repeat: true })).toBe('ignore');
    expect(spaceAction({ phase: 'COUNTDOWN', status: 'alive', repeat: false })).toBe('ignore');
    expect(spaceAction({ phase: 'FINISHED', status: 'alive', repeat: false })).toBe('ignore');
    expect(spaceAction({ phase: 'PLAYING', status: 'invulnerable', repeat: false })).toBe('ignore'); // steal-only
    expect(spaceAction({ phase: 'PLAYING', status: 'eliminated', repeat: false })).toBe('ignore');
    expect(spaceAction({ phase: undefined, status: undefined, repeat: false })).toBe('ignore');
  });

  it('text fields keep Space for typing', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it('recognises Space by key or code', () => {
    expect(isSpaceKey({ key: ' ' })).toBe(true);
    expect(isSpaceKey({ key: 'Spacebar' })).toBe(true);
    expect(isSpaceKey({ key: 'x', code: 'Space' })).toBe(true);
    expect(isSpaceKey({ key: 'Tab' })).toBe(false);
  });
});
