import { createRng } from '@/lib/engine/rng';
import { DEBUG_SETTINGS, DEFAULT_SETTINGS, resolveSettings } from '@/lib/engine/settings';
import { isActivePhase, isPlayPhase } from '@/lib/engine/state';
import type {
  ClientAction,
  GameSettings,
  PresenceRole,
  PublicGameState,
  PublicSessionState,
  WordDictionary,
} from '@/lib/engine/types';
import type { HostRunner } from '@/lib/realtime/hostRunner';
import {
  looksLikePublicSession,
  parseDraft,
  parseRejection,
  type DraftPayload,
  type PresenceMeta,
} from '@/lib/realtime/protocol';
import { createTransport, type RoomTransport, type TransportStatus } from '@/lib/realtime/transport';
import { loadDictionary } from '@/lib/words';
import { REJECT_TEXT } from './copy';
import { randomSeed } from './ids';
import { loadSeq, saveSeq } from './identity';
import { markRevealed } from './revealed';
import { spaceAction } from './shortcuts';
import { initialRoomState, myPlayer, targetOf, useRoom, type InputMode, type Toast } from './store';
import { eventsForView, selectView } from './view';

export interface RoomClientOptions {
  roomCode: string;
  playerId: string;
  nickname: string;
  role: PresenceRole;
  debug?: boolean;
  /** Host only: deterministic secrets for tests (`?seed=42`). */
  seed?: number;
  /** Host only: initial value of enableUnbeatableEarlyFinish (`?early=0`). */
  earlyFinish?: boolean;
}

const DRAFT_MIRROR = process.env.NEXT_PUBLIC_DRAFT_MIRROR !== 'false';
const DRAFT_INTERVAL_MS = 100; // FR-3.6: max 10 draft messages / second
const SYNC_AFTER_MS = 3000; // pending ack missing → ask the host for a fresh snapshot
const RESEND_AFTER_MS = 6000; // still missing → resend the same action (same clientSeq; host dedups)
const GIVE_UP_AFTER_MS = 15000;
const ROOM_NOT_FOUND_MS = 5000; // E-17
const FX_TTL_MS = 4000; // how long synchronized events stay available to overlays

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ActionInput = DistributiveOmit<ClientAction, 'playerId' | 'clientSeq'>;

/**
 * One instance per mounted room page. Owns the transport, the optional HostRunner (when this
 * browser is the host/referee), and all client-side game input logic. React components read the
 * zustand store and call methods on this object; no game rules live in components (FIX 2).
 */
export class RoomClient {
  readonly o: RoomClientOptions;
  private transport: RoomTransport | null = null;
  host: HostRunner | null = null;
  private dictionary: WordDictionary | null = null;
  private seq: number;
  private disposed = false;
  private unsubs: (() => void)[] = [];
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDraftAt = 0;
  private seenEventId = -1;
  private offsetSamples: number[] = [];
  private connectedAt: number | null = null;
  private hostMissingSince: number | null = null;
  private lastSyncRequestAt = 0;
  private toastSeq = 0;

  constructor(opts: RoomClientOptions) {
    this.o = opts;
    this.seq = loadSeq(opts.roomCode);
    useRoom.setState({
      ...initialRoomState(),
      roomCode: opts.roomCode,
      me: opts.playerId,
      nickname: opts.nickname,
      role: opts.role,
      debug: !!opts.debug,
    });
  }

  get isHost(): boolean {
    return this.o.role === 'host';
  }

  async init(): Promise<void> {
    const dictPromise = loadDictionary();
    dictPromise
      .then((d) => {
        this.dictionary = d;
        if (!this.disposed) useRoom.setState({ dictionaryReady: true });
      })
      .catch((err: unknown) => console.error('[room] failed to load word lists', err));

    let transport: RoomTransport;
    try {
      transport = await createTransport(this.o.roomCode, this.o.playerId);
    } catch (err) {
      useRoom.setState({ configError: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (this.disposed) {
      transport.close();
      return;
    }
    this.transport = transport;
    useRoom.setState({ transportKind: transport.kind });

    if (this.isHost) {
      // The referee needs the answer list before it can START, so load it first. The referee code
      // itself is only downloaded by the host's browser (guests never run the engine).
      const [dictionary, { HostRunner }] = await Promise.all([dictPromise, import('@/lib/realtime/hostRunner')]);
      if (this.disposed) return;
      const base: GameSettings = this.o.debug ? { ...DEBUG_SETTINGS } : { ...DEFAULT_SETTINGS };
      const settings = resolveSettings(
        this.o.earlyFinish === undefined ? {} : { enableUnbeatableEarlyFinish: this.o.earlyFinish },
        base,
      );
      this.host = new HostRunner({
        transport,
        roomCode: this.o.roomCode,
        hostId: this.o.playerId,
        hostNickname: this.o.nickname,
        settings,
        dictionary,
        rng: createRng(this.o.seed ?? randomSeed()),
        storage: typeof sessionStorage !== 'undefined' ? sessionStorage : null,
        onPublicState: (pub) => this.applyState(pub),
        debug: this.o.debug,
      });
      this.host.start();
      if (this.o.debug && typeof window !== 'undefined') {
        (window as unknown as { __WR_HOST__?: HostRunner }).__WR_HOST__ = this.host;
      }
    }

    this.unsubs.push(
      transport.on('state', (raw) => this.onState(raw)),
      transport.on('reject', (raw) => this.onReject(raw)),
      transport.on('draft', (raw) => this.onDraft(raw)),
      transport.onPresence((m) => this.onPresence(m)),
      transport.onStatus((s) => this.onStatus(s)),
    );
    transport.track({
      playerId: this.o.playerId,
      nickname: this.o.nickname,
      role: this.o.role,
      joinedAt: Date.now(),
    });
    this.watchdog = setInterval(() => this.onWatchdog(), 500);
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.host?.stop();
    this.transport?.close();
  }

  // -------------------------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------------------------

  private onState(raw: unknown): void {
    if (!looksLikePublicSession(raw) || raw.roomCode !== this.o.roomCode) return;
    const cur = useRoom.getState().session;
    // Once we have followed a referee, ignore snapshots from any other "host" id (see the
    // security notes in docs/ARCHITECTURE.md — this is a sanity check, not authentication).
    if (cur && raw.hostId !== cur.hostId) return;
    if (this.isHost) return; // the host applies its own snapshots directly (no echo needed)
    this.sampleOffset(raw.hostNow);
    if (cur && raw.version <= cur.version) return;
    this.applyState(raw);
  }

  private sampleOffset(hostNowMs: number): void {
    if (this.isHost) return;
    // One-way latency makes every sample an UNDER-estimate, so the max of recent samples is the
    // best estimate of the true offset.
    this.offsetSamples.push(hostNowMs - Date.now());
    if (this.offsetSamples.length > 12) this.offsetSamples.shift();
    useRoom.setState({ clockOffset: Math.max(...this.offsetSamples) });
  }

  applyState(pub: PublicSessionState): void {
    if (this.disposed) return;
    const prev = useRoom.getState();
    const patch: Partial<typeof prev> = { session: pub, localAbandoned: false, roomNotFound: false };
    this.hostMissingSince = null;

    const me = pub.players.find((p) => p.id === this.o.playerId);
    if (me) {
      this.seq = Math.max(this.seq, me.lastSeq);
      // Ack: the host has processed our pending action (accepted or rejected).
      if (prev.pending && me.lastSeq >= prev.pending.clientSeq) {
        patch.pending = null;
        patch.latencies = [...prev.latencies, Date.now() - prev.pending.sentAt].slice(-50);
      }
    }
    useRoom.setState(patch);
    const view = this.refreshView(true);

    // Synchronised animation events (lastEvents) — never replay history on first sync. Only the
    // events of the duel on screen are kept, so another duel's overtime never fires here.
    const newest = pub.lastEvents.reduce((m, e) => Math.max(m, e.id), 0);
    if (this.seenEventId < 0) {
      this.seenEventId = newest;
      markRevealed(pub.duels.flatMap((d) => d.players.flatMap((p) => p.rows.map((r) => r.id))));
    } else if (newest > this.seenEventId) {
      const fresh = eventsForView(
        pub.lastEvents.filter((e) => e.id > this.seenEventId),
        view,
      );
      this.seenEventId = newest;
      const now = Date.now();
      const fx = useRoom.getState().fx;
      useRoom.setState({ fx: [...fx, ...fresh.map((event) => ({ id: event.id, event, at: now }))].slice(-24) });
      const ids = new Set(fresh.map((e) => e.id));
      setTimeout(() => {
        useRoom.setState({ fx: useRoom.getState().fx.filter((f) => !ids.has(f.id)) });
      }, FX_TTL_MS);
    }
  }

  /**
   * Recomputes which screen / duel this viewer sees (lib/client/view.ts). Runs on every snapshot and
   * from the watchdog, because a knocked-out player's result card expires by the clock.
   */
  private refreshView(force = false) {
    const s = useRoom.getState();
    const view = selectView(s.session, this.o.playerId, {
      hostNow: Date.now() + s.clockOffset,
      dismissedDuelId: s.dismissedDuelId,
    });
    if (!force && view.kind === s.view && view.duelId === s.viewDuelId) return view;
    const prevGame = s.game;
    const patch: Partial<typeof s> = { view: view.kind, viewDuelId: view.duelId, game: view.game };
    // New duel on screen (start / re-pairing / new session): clear all input state.
    if (prevGame && view.game && view.game.matchNumber !== prevGame.matchNumber) {
      Object.assign(patch, { draft: '', pending: null, mode: 'own' as InputMode, drafts: {} });
    }
    useRoom.setState(patch);
    this.reconcileMode(prevGame);
    return view;
  }

  /** FR-6.5: skip a result card and go straight to spectating. */
  dismissResult(): void {
    const id = useRoom.getState().viewDuelId;
    useRoom.setState({ dismissedDuelId: id });
    this.refreshView();
  }

  /** FR-4.4 / FR-4.7: keep the input mode legal as statuses change. */
  private reconcileMode(prevGame: PublicGameState | null): void {
    const s = useRoom.getState();
    const me = myPlayer(s);
    const target = targetOf(s);
    if (!me || !s.game || !isPlayPhase(s.game.phase)) return;
    const prevMe = prevGame?.players.find((p) => p.id === me.id);
    if (me.status === 'invulnerable' && prevMe?.status !== 'invulnerable') {
      useRoom.setState({ mode: 'steal' }); // FR-4.7: solved → steal mode by default
      return;
    }
    if (s.mode === 'steal' && me.status === 'alive' && target && target.status !== 'alive') {
      useRoom.setState({ mode: 'own' });
      this.toast(target.status === 'invulnerable' ? `${target.nickname} is shielded!` : 'Target eliminated', 'warn');
    }
  }

  private onReject(raw: unknown): void {
    const r = parseRejection(raw);
    if (!r || r.playerId !== this.o.playerId) return;
    const s = useRoom.getState();
    this.toast(REJECT_TEXT[r.reason] ?? 'Rejected', r.reason === 'target_shielded' ? 'warn' : 'error');
    if (s.pending && s.pending.clientSeq === r.clientSeq) {
      useRoom.setState({
        pending: null,
        draft: s.draft || s.pending.word,
        shake: s.shake + 1,
        latencies: [...s.latencies, Date.now() - s.pending.sentAt].slice(-50),
      });
    }
  }

  private onDraft(raw: unknown): void {
    const d = parseDraft(raw);
    if (!d || d.playerId === this.o.playerId) return;
    const s = useRoom.getState();
    useRoom.setState({ drafts: { ...s.drafts, [d.playerId]: d } });
  }

  private onPresence(members: PresenceMeta[]): void {
    const game = useRoom.getState().game;
    const hostPresent =
      this.isHost || members.some((m) => (game ? m.playerId === game.hostId : m.role === 'host'));
    if (hostPresent) this.hostMissingSince = null;
    else if (this.hostMissingSince === null) this.hostMissingSince = Date.now();
    useRoom.setState({ presence: members, hostPresent });
  }

  private onStatus(status: TransportStatus): void {
    useRoom.setState({ connection: status });
    if (status === 'connected') {
      this.connectedAt ??= Date.now();
      if (!this.isHost) this.requestSync(true); // NFR-6: resync on every (re)connect
    }
  }

  private requestSync(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSyncRequestAt < 2000) return;
    this.lastSyncRequestAt = now;
    this.transport?.send('sync_request', { playerId: this.o.playerId });
  }

  private onWatchdog(): void {
    this.refreshView();
    const s = useRoom.getState();
    const now = Date.now();

    // Pending-ack recovery (FIX 4 / FIX 7).
    if (s.pending) {
      const age = now - s.pending.sentAt;
      if (age > GIVE_UP_AFTER_MS) {
        useRoom.setState({ pending: null, draft: s.draft || s.pending.word });
        this.toast('Connection problem — try again', 'error');
      } else if (age > RESEND_AFTER_MS && !s.pending.resent) {
        const p = s.pending;
        this.transport?.send(
          'action',
          p.kind === 'own'
            ? { type: 'GUESS', playerId: this.o.playerId, clientSeq: p.clientSeq, word: p.word, duelId: p.duelId }
            : {
                type: 'STEAL',
                playerId: this.o.playerId,
                clientSeq: p.clientSeq,
                word: p.word,
                targetId: p.targetId,
                duelId: p.duelId,
              },
        );
        useRoom.setState({ pending: { ...p, resent: true } });
      } else if (age > SYNC_AFTER_MS && !s.pending.syncRequested) {
        this.requestSync(true);
        useRoom.setState({ pending: { ...s.pending, syncRequested: true } });
      }
    }

    if (this.isHost) return;

    // No snapshot yet: keep asking; E-17 room-not-found after 5 s without a host.
    if (!s.session && s.connection === 'connected') {
      this.requestSync();
      if (!s.hostPresent && this.connectedAt && now - this.connectedAt > ROOM_NOT_FOUND_MS && !s.roomNotFound) {
        useRoom.setState({ roomNotFound: true });
      }
    }

    // GR-36 (client side): host absent longer than its grace period.
    if (s.session && !s.hostPresent && this.hostMissingSince !== null && !s.localAbandoned) {
      if (now - this.hostMissingSince > s.session.settings.hostGraceMs && s.session.phase !== 'ABANDONED') {
        useRoom.setState({ localAbandoned: true });
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------------------------

  private sendAction(action: ActionInput): number {
    this.seq += 1;
    saveSeq(this.o.roomCode, this.seq);
    this.transport?.send('action', { ...action, playerId: this.o.playerId, clientSeq: this.seq } as ClientAction);
    return this.seq;
  }

  start(): void {
    this.sendAction({ type: 'START' });
  }

  /** KH-13: "New session" (the 1.0 Rematch button). */
  rematch(): void {
    this.sendAction({ type: 'NEW_SESSION' });
  }

  returnToLobby(): void {
    this.sendAction({ type: 'RETURN_TO_LOBBY' });
  }

  updateSettings(patch: Partial<GameSettings>): void {
    this.sendAction({ type: 'UPDATE_SETTINGS', patch });
  }

  /** Whether this client may type right now. */
  canType(): boolean {
    const s = useRoom.getState();
    const me = myPlayer(s);
    if (!s.game || !isPlayPhase(s.game.phase) || !me || me.status === 'eliminated' || s.localAbandoned) return false;
    if (me.status === 'invulnerable') {
      const target = targetOf(s);
      return me.postSolveStealRows > 0 && !!target && target.status === 'alive';
    }
    return true;
  }

  /** FR-4.4: why steal mode is (un)available. */
  stealBlockReason(): string | null {
    const s = useRoom.getState();
    const me = myPlayer(s);
    const target = targetOf(s);
    if (!s.game || !isPlayPhase(s.game.phase) || !me) return 'Not in play';
    if (me.status === 'eliminated') return 'You’re eliminated';
    if (!target) return 'No target';
    if (target.status === 'invulnerable') return `${target.nickname} is shielded`;
    if (target.status === 'eliminated') return `${target.nickname} is eliminated`;
    if (me.status === 'invulnerable' && me.postSolveStealRows <= 0) return 'Out of ammo';
    return null;
  }

  setMode(mode: InputMode): void {
    const s = useRoom.getState();
    const me = myPlayer(s);
    if (!me || s.mode === mode) return;
    if (mode === 'steal') {
      const blocked = this.stealBlockReason();
      if (blocked) {
        this.toast(blocked, 'warn');
        return;
      }
    } else if (me.status === 'invulnerable') {
      this.toast('You already solved — attack instead!', 'info');
      return;
    }
    useRoom.setState({ mode }); // FR-4.3: the draft is kept when switching modes
    this.scheduleDraft();
  }

  toggleMode(): void {
    this.setMode(useRoom.getState().mode === 'own' ? 'steal' : 'own');
  }

  /** FR-4.2a: Space toggles own ⇄ steal. Ignored outside play and once shielded (steal-only). */
  spaceToggle(repeat: boolean): void {
    const s = useRoom.getState();
    const me = myPlayer(s);
    const action = spaceAction({ phase: s.game?.phase, status: me?.status, repeat });
    if (action === 'toggle') this.toggleMode();
  }

  typeLetter(ch: string): void {
    const letter = ch.toUpperCase();
    if (!/^[A-Z]$/.test(letter) || !this.canType()) return;
    const s = useRoom.getState();
    const len = s.game?.settings.wordLength ?? 5;
    if (s.draft.length >= len) return;
    useRoom.setState({ draft: s.draft + letter });
    this.scheduleDraft();
  }

  backspace(): void {
    const s = useRoom.getState();
    if (!s.draft || !this.canType()) return;
    useRoom.setState({ draft: s.draft.slice(0, -1) });
    this.scheduleDraft();
  }

  /** FR-3.3: client-side validation (GR-11/12/13) before anything is sent. */
  submit(): void {
    const s = useRoom.getState();
    const me = myPlayer(s);
    if (!me || !s.game || !this.canType()) return;
    if (s.pending) {
      this.toast('Waiting for the referee…', 'info'); // FIX 4: no double submission
      return;
    }
    const word = s.draft;
    const reject = (text: string) => {
      useRoom.setState({ shake: s.shake + 1 });
      this.toast(text, 'error');
    };
    if (word.length < s.game.settings.wordLength) return reject('Not enough letters');
    if (this.dictionary && !this.dictionary.isValid(word)) return reject(REJECT_TEXT.invalid_word);

    const mode: InputMode = me.status === 'invulnerable' ? 'steal' : s.mode;
    const target = targetOf(s);
    if (mode === 'own') {
      if (me.rows.some((r) => r.targetId === me.id && r.word === word)) return reject(REJECT_TEXT.duplicate);
      const clientSeq = this.sendAction({ type: 'GUESS', word, duelId: s.viewDuelId });
      this.setPending(clientSeq, word, 'own', me.id);
    } else {
      const blocked = this.stealBlockReason();
      if (blocked || !target) return reject(blocked ?? 'No target');
      if (me.rows.some((r) => r.targetId === target.id && r.word === word)) return reject(REJECT_TEXT.duplicate);
      const clientSeq = this.sendAction({ type: 'STEAL', targetId: target.id, word, duelId: s.viewDuelId });
      this.setPending(clientSeq, word, 'steal', target.id);
    }
  }

  private setPending(clientSeq: number, word: string, kind: 'own' | 'steal', targetId: string): void {
    useRoom.setState({
      pending: {
        clientSeq,
        duelId: useRoom.getState().viewDuelId,
        word,
        kind,
        targetId,
        sentAt: Date.now(),
        syncRequested: false,
        resent: false,
      },
      draft: '',
    });
    this.scheduleDraft(true);
  }

  // FR-3.6 / GR-8: throttled draft mirroring (≤ 10 / s), dropped while disconnected.
  private scheduleDraft(immediate = false): void {
    if (!DRAFT_MIRROR || !this.transport) return;
    const s = useRoom.getState();
    if (!s.game || !isPlayPhase(s.game.phase) || !myPlayer(s)) return;
    const send = () => {
      this.draftTimer = null;
      this.lastDraftAt = Date.now();
      const cur = useRoom.getState();
      const target = targetOf(cur);
      const payload: DraftPayload = {
        playerId: this.o.playerId,
        letters: cur.draft,
        mode: cur.mode,
        targetId: cur.mode === 'steal' ? target?.id : undefined,
        matchNumber: cur.game?.matchNumber ?? 0,
        duelId: cur.viewDuelId,
      };
      this.transport?.send('draft', payload);
    };
    const wait = DRAFT_INTERVAL_MS - (Date.now() - this.lastDraftAt);
    if (immediate || wait <= 0) {
      if (this.draftTimer) clearTimeout(this.draftTimer);
      send();
    } else if (!this.draftTimer) {
      this.draftTimer = setTimeout(send, wait);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Toasts (FR-5.4: max 3 visible)
  // -------------------------------------------------------------------------------------------

  toast(text: string, tone: Toast['tone'] = 'info'): void {
    const id = ++this.toastSeq;
    const toasts = [...useRoom.getState().toasts, { id, text, tone }].slice(-3);
    useRoom.setState({ toasts });
    setTimeout(() => {
      useRoom.setState({ toasts: useRoom.getState().toasts.filter((t) => t.id !== id) });
    }, 2600);
  }
}

export function isActive(game: PublicGameState | null): boolean {
  return !!game && isActivePhase(game.phase);
}
