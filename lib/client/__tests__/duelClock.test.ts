import { describe, expect, it } from 'vitest';
import type { PublicGameState, PublicPlayer } from '@/lib/engine/types';
import { clockOf, isSpaceKey, isTextEntryTarget, spaceAction } from '../clock';
import { matchups } from '../players';

const player = (id: string, extra: Partial<PublicPlayer> = {}): PublicPlayer => ({
  id,
  nickname: id,
  isHost: false,
  connected: true,
  status: 'alive',
  rows: [],
  rowLimit: 6,
  rowsUsed: 0,
  postSolveStealRows: 0,
  lastSeq: 0,
  ...extra,
});

const game = (players: PublicPlayer[], extra: Partial<PublicGameState> = {}): PublicGameState =>
  ({ phase: 'PLAYING', phaseEndsAt: 5_000, players, ...extra }) as PublicGameState;

describe('v1.1 FD-7: which clock a viewer sees', () => {
  it('2 players: the match clock', () => {
    const g = game([player('a'), player('b')]);
    expect(clockOf(g, g.players[0])).toEqual({ phase: 'PLAYING', endsAt: 5_000 });
    expect(clockOf(g)).toEqual({ phase: 'PLAYING', endsAt: 5_000 }); // the duel spectator too
  });

  it('battle royale: each player’s own duel clock; nothing while waiting or for spectators', () => {
    const a = player('a', { targetId: 'b', duelPhase: 'OVERTIME', duelEndsAt: 9_000 });
    const b = player('b', { targetId: 'a', duelPhase: 'OVERTIME', duelEndsAt: 9_000 });
    const c = player('c');
    const g = game([a, b, c], { phaseEndsAt: undefined });
    expect(clockOf(g, a)).toEqual({ phase: 'OVERTIME', endsAt: 9_000 });
    expect(clockOf(g, c)).toEqual({});
    expect(clockOf(g)).toEqual({});
  });
});

describe('FR-4.2a Spacebar toggle', () => {
  it('toggles only for an alive, paired player on a running clock, never on key repeat', () => {
    const base = { clockPhase: 'PLAYING' as const, status: 'alive' as const, waiting: false, repeat: false };
    expect(spaceAction(base)).toBe('toggle');
    expect(spaceAction({ ...base, clockPhase: 'OVERTIME' })).toBe('toggle');
    expect(spaceAction({ ...base, repeat: true })).toBe('ignore');
    expect(spaceAction({ ...base, waiting: true })).toBe('ignore');
    expect(spaceAction({ ...base, clockPhase: 'COUNTDOWN' })).toBe('ignore');
    expect(spaceAction({ ...base, clockPhase: undefined })).toBe('ignore');
    expect(spaceAction({ ...base, status: 'invulnerable' })).toBe('ignore'); // steal-only
    expect(spaceAction({ ...base, status: 'eliminated' })).toBe('ignore');
  });

  it('text fields keep Space for typing; Space is recognised by key or code', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isSpaceKey({ key: ' ' })).toBe(true);
    expect(isSpaceKey({ key: 'x', code: 'Space' })).toBe(true);
    expect(isSpaceKey({ key: 'Tab' })).toBe(false);
  });
});

describe('v1.1 WR-5: waiting-room matchups', () => {
  it('groups the players still in the battle by duel and lists who is waiting', () => {
    const ps = [
      player('a', { targetId: 'b' }),
      player('b', { targetId: 'a' }),
      player('c'),
      player('d', { status: 'eliminated', targetId: 'c' }),
      player('e', { targetId: 'f', status: 'invulnerable' }),
      player('f', { targetId: 'e' }),
    ];
    const m = matchups(ps);
    expect(m.duels.map(([x, y]) => `${x.id}-${y.id}`)).toEqual(['a-b', 'e-f']);
    expect(m.waiting.map((p) => p.id)).toEqual(['c']);
  });
});
