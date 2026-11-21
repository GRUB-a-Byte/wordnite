import { reduce } from '../reducer';
import { DEFAULT_SETTINGS, resolveSettings } from '../settings';
import { createLobbyState } from '../state';
import type {
  ClientAction,
  DistributiveOmit,
  EngineAction,
  GameSettings,
  PrivateGameState,
  PrivatePlayer,
  ReduceResult,
  WordDictionary,
} from '../types';

/** A tiny dictionary so tests are readable. All are valid guesses. */
export const TEST_WORDS = [
  'CRANE', 'SLATE', 'ABBEY', 'BOBBY', 'SPEED', 'ERASE', 'MOUND', 'PIOUS', 'TRAIN', 'GHOST',
  'PLUMB', 'FJORD', 'WALTZ', 'NYMPH', 'QUICK', 'BRICK', 'JUMPY', 'VIXEN', 'GLYPH', 'DWARF',
  'MOUNT', 'STEAK', 'CHAIR', 'LEMON', 'OCEAN', 'PRISM', 'TOAST', 'UNCLE', 'ZEBRA', 'KNIFE',
];

export function testDictionary(answers: readonly string[] = ['CRANE', 'SLATE']): WordDictionary {
  const set = new Set([...TEST_WORDS, ...answers]);
  return { isValid: (w) => set.has(w.toUpperCase()), answers };
}

export const A = 'pA';
export const B = 'pB';

/**
 * Drives the engine like the HostRunner does: one action at a time, with an injected clock, rng
 * and dictionary, auto-numbering each player's clientSeq. Subclasses set up the room.
 */
export class EngineHarness {
  state: PrivateGameState;
  now = 1_000_000;
  dictionary: WordDictionary;
  rng: () => number;
  last!: ReduceResult;
  private seqs = new Map<string, number>();

  constructor(state: PrivateGameState, dictionary: WordDictionary, rng: () => number) {
    this.state = state;
    this.dictionary = dictionary;
    this.rng = rng;
  }

  dispatch(action: EngineAction): ReduceResult {
    this.last = reduce(this.state, action, { now: this.now, rng: this.rng, dictionary: this.dictionary });
    this.state = this.last.state;
    return this.last;
  }

  nextSeq(playerId: string): number {
    const n = (this.seqs.get(playerId) ?? 0) + 1;
    this.seqs.set(playerId, n);
    return n;
  }

  client(action: DistributiveOmit<ClientAction, 'clientSeq'>): ReduceResult {
    return this.dispatch({ ...action, clientSeq: this.nextSeq(action.playerId) } as ClientAction);
  }

  advance(ms: number): ReduceResult {
    this.now += ms;
    return this.dispatch({ type: 'TICK' });
  }

  guess(playerId: string, word: string): ReduceResult {
    return this.client({ type: 'GUESS', playerId, word });
  }

  p(id: string): PrivatePlayer {
    const p = this.state.players.find((x) => x.id === id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  /** Burns `n` own-guess rows for a player using distinct TEST_WORDS not in `avoid` (default: their own secret). */
  burn(playerId: string, n: number, avoid: readonly string[] = [this.p(playerId).secret]): void {
    const p = this.p(playerId);
    const used = new Set(p.rows.filter((r) => r.targetId === p.id).map((r) => r.word));
    const words = TEST_WORDS.filter((w) => !avoid.includes(w) && !used.has(w));
    for (let i = 0; i < n; i++) {
      const res = this.guess(playerId, words[i] as string);
      if (res.rejections.length) throw new Error(`burn rejected: ${res.rejections[0]?.reason}`);
    }
  }
}

/**
 * The two-player duel (alice = A hosts, bob = B joins).
 * `secrets` are forced by giving the dictionary exactly those answers and an rng that returns 0
 * (pickSecrets then picks them in order).
 */
export class Sim extends EngineHarness {
  constructor(opts: { settings?: Partial<GameSettings>; secrets?: [string, string] } = {}) {
    const settings = resolveSettings(opts.settings ?? {}, DEFAULT_SETTINGS);
    super(
      createLobbyState({ roomCode: 'TEST', hostId: A, hostNickname: 'alice', settings }),
      testDictionary(opts.secrets ?? ['CRANE', 'SLATE']),
      () => 0,
    );
    this.dispatch({ type: 'PRESENCE_JOIN', playerId: B, nickname: 'bob', role: 'player' });
  }

  /** START + skip the countdown → PLAYING. */
  startPlaying(): this {
    this.client({ type: 'START', playerId: A });
    this.advance(this.state.settings.countdownMs);
    return this;
  }

  steal(playerId: string, word: string, targetId = playerId === A ? B : A): ReduceResult {
    return this.client({ type: 'STEAL', playerId, targetId, word });
  }
}
