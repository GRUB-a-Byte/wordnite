import { describe, expect, it } from 'vitest';
import { looksLikeWireState, parseClientAction, parseDraft, parsePresenceMeta } from '../protocol';

describe('wire protocol validation', () => {
  it('accepts well-formed client actions', () => {
    expect(parseClientAction({ type: 'GUESS', playerId: 'p1', clientSeq: 3, word: 'crane' })).toEqual({
      type: 'GUESS',
      playerId: 'p1',
      clientSeq: 3,
      word: 'crane',
    });
    expect(parseClientAction({ type: 'STEAL', playerId: 'p1', clientSeq: 4, word: 'SLATE', targetId: 'p2' })).toMatchObject({
      type: 'STEAL',
      targetId: 'p2',
    });
    expect(parseClientAction({ type: 'START', playerId: 'p1', clientSeq: 1 })).toEqual({
      type: 'START',
      playerId: 'p1',
      clientSeq: 1,
    });
  });

  it('strips unknown fields (no smuggling of e.g. "secret" or "status")', () => {
    const a = parseClientAction({ type: 'GUESS', playerId: 'p1', clientSeq: 1, word: 'CRANE', status: 'invulnerable' });
    expect(a).not.toHaveProperty('status');
  });

  it('only forwards known settings keys with primitive values', () => {
    const a = parseClientAction({
      type: 'UPDATE_SETTINGS',
      playerId: 'p1',
      clientSeq: 2,
      patch: { enableUnbeatableEarlyFinish: false, matchMs: 60000, evil: 'x', baseRows: { a: 1 } },
    });
    expect(a).toEqual({
      type: 'UPDATE_SETTINGS',
      playerId: 'p1',
      clientSeq: 2,
      patch: { enableUnbeatableEarlyFinish: false, matchMs: 60000 },
    });
  });

  it('rejects malformed actions', () => {
    const bad = [
      null,
      'GUESS',
      {},
      { type: 'GUESS', playerId: 'p1', clientSeq: 1 },
      { type: 'GUESS', playerId: '', clientSeq: 1, word: 'CRANE' },
      { type: 'GUESS', playerId: 'p1', clientSeq: 0, word: 'CRANE' },
      { type: 'GUESS', playerId: 'p1', clientSeq: 1.5, word: 'CRANE' },
      { type: 'GUESS', playerId: 'p1', clientSeq: 1, word: 'X'.repeat(100) },
      { type: 'STEAL', playerId: 'p1', clientSeq: 1, word: 'CRANE' },
      { type: 'TICK', playerId: 'p1', clientSeq: 1 },
      { type: 'PRESENCE_LEAVE', playerId: 'p1', clientSeq: 1 },
      { type: 'ABANDON', playerId: 'p1', clientSeq: 1 },
    ];
    for (const b of bad) expect(parseClientAction(b)).toBeNull();
  });

  it('presence and draft payloads are sanitised', () => {
    expect(parsePresenceMeta({ playerId: 'p1', nickname: 'x'.repeat(40), role: 'player', joinedAt: 5 })?.nickname).toHaveLength(16);
    expect(parsePresenceMeta({ playerId: 'p1', role: 'admin' })).toBeNull();
    expect(parseDraft({ playerId: 'p1', letters: 'ab<script>cdefg', mode: 'steal', matchNumber: 1 })).toMatchObject({
      letters: 'ABSCR',
      mode: 'steal',
    });
  });

  it('recognises public state snapshots', () => {
    expect(looksLikeWireState({ version: 1, roomCode: 'ABCD', hostId: 'h', phase: 'LOBBY', players: [] })).toBe(true);
    expect(looksLikeWireState({ version: '1' })).toBe(false);
  });
});
