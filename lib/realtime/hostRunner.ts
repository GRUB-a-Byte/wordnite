import { findLeakedSecrets, toPublicState } from '@/lib/engine/project';
import { reduce } from '@/lib/engine/reducer';
import { createLobbyState, isActivePhase, isBattleRoyale } from '@/lib/engine/state';
import type {
  EngineAction,
  GameSettings,
  PrivateGameState,
  PublicGameState,
  WordDictionary,
} from '@/lib/engine/types';
import { parseClientAction, type PresenceMeta } from './protocol';
import { encodeState, makeDelta, type WireState } from './wire';
import type { RoomTransport, TransportStatus } from './transport';

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface HostRunnerOptions {
  transport: RoomTransport;
  roomCode: string;
  hostId: string;
  hostNickname: string;
  /** Used only when creating a fresh room (a restored room keeps its own settings). */
  settings: GameSettings;
  dictionary: WordDictionary;
  rng: () => number;
  storage: KV | null;
  now?: () => number;
  /** Applies the public snapshot to the host's own UI immediately (no network round trip). */
  onPublicState: (s: PublicGameState) => void;
  debug?: boolean;
  tickMs?: number;
}

export const stateKey = (code: string) => `wr:state:${code}`;
/** Big games: coalesce broadcasts into one per BATCH_MS (a duel always sends immediately). */
const BATCH_MS = 100;
/** Full snapshot at least this often (deltas in between; clients resync on any gap). */
const FULL_EVERY_MS = 20_000;
export const beatKey = (code: string) => `wr:hostbeat:${code}`;

/**
 * The referee loop that runs in the host's browser (SRS §8.1, D-13).
 *
 *  - Owns the authoritative PrivateGameState (with secrets). Only `toPublicState()` output is sent.
 *  - Applies actions strictly one at a time in arrival order (JS is single-threaded and every
 *    dispatch is synchronous, so this is a FIFO queue by construction).
 *  - TICKs every 250 ms; the reducer also checks deadlines on every action (FIX 6).
 *  - Persists state + a heartbeat to sessionStorage so a host refresh can resume (E-15 / NFR-7).
 *  - Abandons the match if the host itself has been offline longer than hostGraceMs (GR-36).
 */
export class HostRunner {
  private state: PrivateGameState;
  private readonly o: HostRunnerOptions;
  private readonly now: () => number;
  private unsubs: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private offlineSince: number | null = null;
  private lastBroadcastAt = 0;
  private lastBeatAt = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFull = false;
  private lastWire: WireState | null = null;
  private lastFullAt = 0;
  readonly restored: boolean;

  constructor(opts: HostRunnerOptions) {
    this.o = opts;
    this.now = opts.now ?? (() => Date.now());
    const restored = this.restore();
    this.restored = !!restored;
    this.state =
      restored ??
      createLobbyState({
        roomCode: opts.roomCode,
        hostId: opts.hostId,
        hostNickname: opts.hostNickname,
        settings: opts.settings,
      });
  }

  /** Read-only snapshot (debug / tests). Contains secrets — never send this anywhere. */
  get privateState(): PrivateGameState {
    return this.state;
  }

  start(): void {
    const t = this.o.transport;
    this.unsubs.push(
      t.on('action', (raw) => {
        const action = parseClientAction(raw);
        if (action) this.dispatch(action);
      }),
      t.on('sync_request', () => this.scheduleSync()),
      t.onPresence((members) => this.onPresence(members)),
      t.onStatus((status) => this.onStatus(status)),
    );

    // A host that comes back after more than hostGraceMs finds its match abandoned (GR-36): guests
    // have already shown "Host left" by then, so both sides must agree.
    if (this.restored && isActivePhase(this.state.phase)) {
      const beat = Number(this.o.storage?.getItem(beatKey(this.o.roomCode)) ?? 0);
      if (!beat || this.now() - beat > this.state.settings.hostGraceMs) this.dispatch({ type: 'ABANDON' });
    }

    this.tickTimer = setInterval(() => this.onTick(), this.o.tickMs ?? 250);
    this.beat();
    this.publish({ full: true });
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  /** Feeds one action through the engine. Synchronous → strict FIFO. */
  dispatch(action: EngineAction): void {
    let res;
    try {
      res = reduce(this.state, action, { now: this.now(), rng: this.o.rng, dictionary: this.o.dictionary });
    } catch (err) {
      console.error('[host] engine error — action ignored', action, err);
      return;
    }
    let resync = false;
    for (const r of res.rejections) {
      if (r.reason === 'duplicate_seq') resync = true; // re-delivery: just resend state (the ack)
      else this.o.transport.send('reject', r);
    }
    if (res.changed) {
      this.state = res.state;
      this.persist();
      this.publish({ full: resync });
    } else if (resync) {
      this.publish({ full: true }); // the client may have missed updates — give it everything
    }
  }

  private onTick(): void {
    const now = this.now();
    // GR-36 host side: our own connection has been down too long → abandon.
    if (this.offlineSince !== null && isActivePhase(this.state.phase)) {
      if (now - this.offlineSince > this.state.settings.hostGraceMs) this.dispatch({ type: 'ABANDON' });
    }
    this.dispatch({ type: 'TICK' });
    if (now - this.lastBeatAt >= 1000) this.beat();
    // Heartbeat: Broadcast is at-most-once, so every few seconds send a (tiny) delta. Clients that
    // missed something notice the version gap and request a full snapshot; it also keeps their clock
    // offsets fresh.
    if (isActivePhase(this.state.phase) && now - this.lastBroadcastAt > 3000 && !this.batchTimer) this.flush();
  }

  private onStatus(status: TransportStatus): void {
    if (status === 'connected') {
      this.offlineSince = null;
      this.publish({ full: true });
    } else if (status === 'reconnecting' && this.offlineSince === null) {
      this.offlineSince = this.now();
    }
  }

  /**
   * Presence → engine. Diffs the live member list against the engine's roster so that a restored
   * host also notices guests who left while it was away.
   */
  private onPresence(members: PresenceMeta[]): void {
    const hostId = this.o.hostId;
    const present = new Map(members.filter((m) => m.playerId !== hostId).map((m) => [m.playerId, m]));
    for (const m of present.values()) {
      const known =
        this.state.players.find((p) => p.id === m.playerId) ?? this.state.spectators.find((s) => s.id === m.playerId);
      if (!known || !known.connected) {
        this.dispatch({ type: 'PRESENCE_JOIN', playerId: m.playerId, nickname: m.nickname, role: m.role });
      }
    }
    for (const p of [...this.state.players]) {
      if (p.id !== hostId && p.connected && !present.has(p.id)) this.dispatch({ type: 'PRESENCE_LEAVE', playerId: p.id });
    }
    for (const s of [...this.state.spectators]) {
      if (s.connected && !present.has(s.id)) this.dispatch({ type: 'PRESENCE_LEAVE', playerId: s.id });
    }
  }

  private scheduleSync(): void {
    if (this.syncTimer) return; // coalesce bursts of sync_requests
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.publish({ full: true });
    }, 50);
  }

  /**
   * After every change: the host's own UI updates immediately; the network broadcast goes out now
   * for a duel, or batched (one per BATCH_MS) in a battle royale so 100 players guessing at once
   * do not flood the channel.
   */
  private publish(opts: { full?: boolean } = {}): void {
    if (opts.full) this.pendingFull = true;
    if (!isBattleRoyale(this.state.players.length)) {
      this.flush();
      return;
    }
    this.o.onPublicState(toPublicState(this.state, this.now()));
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.flush({ localAlreadyApplied: true });
      }, BATCH_MS);
    }
  }

  /** Sends a full snapshot when needed, otherwise just what changed since the last broadcast. */
  private flush(opts: { localAlreadyApplied?: boolean } = {}): void {
    const now = this.now();
    const pub = toPublicState(this.state, now);
    if (this.o.debug || process.env.NODE_ENV !== 'production') {
      const leaked = findLeakedSecrets(this.state, pub);
      if (leaked.length) {
        console.error('[host] BLOCKED a public state that contained an active secret', leaked);
        return;
      }
    }
    const wire = encodeState(pub);
    const full = this.pendingFull || !this.lastWire || now - this.lastFullAt > FULL_EVERY_MS;
    if (full) {
      this.o.transport.send('state', wire);
      this.lastFullAt = now;
      this.pendingFull = false;
    } else {
      this.o.transport.send('state_delta', makeDelta(this.lastWire as WireState, wire));
    }
    this.lastWire = wire;
    this.lastBroadcastAt = now;
    if (!opts.localAlreadyApplied) this.o.onPublicState(pub);
  }

  private persist(): void {
    try {
      this.o.storage?.setItem(stateKey(this.o.roomCode), JSON.stringify(this.state));
    } catch {
      // storage full / disabled — the match still works, it just can't survive a refresh
    }
  }

  private beat(): void {
    this.lastBeatAt = this.now();
    try {
      this.o.storage?.setItem(beatKey(this.o.roomCode), String(this.lastBeatAt));
    } catch {
      /* ignore */
    }
  }

  private restore(): PrivateGameState | null {
    try {
      const raw = this.o.storage?.getItem(stateKey(this.o.roomCode));
      if (!raw) return null;
      const s = JSON.parse(raw) as PrivateGameState;
      if (s.roomCode !== this.o.roomCode || s.hostId !== this.o.hostId || !Array.isArray(s.players)) return null;
      return s;
    } catch {
      return null;
    }
  }
}
