import { expect, test } from '@playwright/test';
import type { PublicGameState, PublicPlayer } from '../lib/engine/types';
import { applyDelta, decodeState, type WireDelta, type WireState } from '../lib/realtime/wire';
import { PACKED_ANSWERS } from '../lib/words/answers';
import { createRoom } from './helpers';

/**
 * OPT-IN stress test (LOADTEST=1): one real browser host + 99 bot agents playing a full
 * 100-player battle royale against each other over the local relay (v1.1 rules: fresh duels,
 * per-duel clocks, waiting room).
 *
 * Each bot follows the game exactly like RoomClient (full snapshot + deltas, resync on gaps) and:
 *  - acts only while it has an opponent and its OWN duel clock is running (FD-7, WR-1);
 *  - mixes own guesses (random answer words) with steal attempts at its opponent;
 *  - once in a while deliberately tries to act while WAITING — the referee must refuse every one.
 * The host plays nothing (it is the referee and its browser renders the arena), so it outlasts the
 * bots that run out of rows. Measures ack latency, resyncs, traffic, host CPU / heap, page errors
 * and rule invariants seen on the wire. Does NOT exercise Supabase.
 *
 *   LOADTEST=1 npx playwright test e2e/load-100.spec.ts
 */
test.skip(!process.env.LOADTEST, 'opt-in: set LOADTEST=1');

const RELAY = `ws://localhost:${process.env.E2E_RELAY_PORT ?? 8788}`;
const BOTS = 99;
const WORDS = Array.from({ length: PACKED_ANSWERS.length / 5 }, (_, i) => PACKED_ANSWERS.slice(i * 5, i * 5 + 5));
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)] as string;

const inDuel = (p: PublicPlayer) => p.status !== 'eliminated' && !!p.targetId;
const clockRunning = (p: PublicPlayer) => p.duelPhase === 'PLAYING' || p.duelPhase === 'OVERTIME';

class Bot {
  ws: WebSocket;
  state: PublicGameState | null = null;
  seq = 0;
  sent = new Map<number, number>();
  latencies: number[] = [];
  resyncs = 0;
  bytes = 0;
  deltas = 0;
  fulls = 0;
  guesses = 0;
  steals = 0;
  rejects: Record<string, number> = {};
  illegalSent = 0;
  violations: string[] = [];
  duels = 0;
  private lastTarget: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly id: string,
    readonly room: string,
    readonly checkInvariants: boolean,
  ) {
    this.ws = new WebSocket(RELAY);
    this.ws.onopen = () => this.raw({ t: 'join', room, key: id });
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
  }

  private raw(msg: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  private send(event: string, payload: unknown) {
    this.raw({ t: 'bc', event, payload });
  }

  private onMessage(data: string) {
    this.bytes += data.length;
    const msg = JSON.parse(data) as { t: string; event?: string; payload?: unknown };
    if (msg.t === 'joined') {
      this.raw({ t: 'track', meta: { playerId: this.id, nickname: this.id, role: 'player', joinedAt: Date.now() } });
      this.send('sync_request', { playerId: this.id });
      return;
    }
    if (msg.t !== 'bc') return;
    if (msg.event === 'reject') {
      const r = msg.payload as { playerId: string; reason: string };
      if (r.playerId === this.id) this.rejects[r.reason] = (this.rejects[r.reason] ?? 0) + 1;
    } else if (msg.event === 'state') {
      this.fulls++;
      const s = decodeState(msg.payload as WireState);
      if (!this.state || s.version > this.state.version) this.apply(s);
    } else if (msg.event === 'state_delta') {
      this.deltas++;
      const d = msg.payload as WireDelta;
      if (!this.state) return;
      if (d.v <= this.state.version) return;
      const next = d.base === this.state.version ? applyDelta(this.state, d) : null;
      if (!next) {
        this.resyncs++;
        this.send('sync_request', { playerId: this.id });
        return;
      }
      this.apply(next);
    }
  }

  private apply(s: PublicGameState) {
    const prevMe = this.state?.players.find((p) => p.id === this.id);
    this.state = s;
    const me = s.players.find((p) => p.id === this.id);
    if (!me) return;
    for (const [seq, at] of this.sent) {
      if (me.lastSeq >= seq) {
        this.latencies.push(Date.now() - at);
        this.sent.delete(seq);
      }
    }
    if (me.targetId && me.targetId !== this.lastTarget) this.duels++;
    this.lastTarget = me.targetId;
    // WR-1 on the wire: a waiting player's board never grows.
    if (prevMe && s.phase === 'PLAYING' && !prevMe.targetId && !me.targetId && me.rows.length > prevMe.rows.length) {
      this.violations.push(`${this.id} gained a row while waiting`);
    }
    if (this.checkInvariants && s.phase === 'PLAYING') this.check(s);

    const playing = s.phase === 'PLAYING' || s.phase === 'OVERTIME';
    if (playing && !this.timer) this.timer = setInterval(() => this.act(), 1200 + Math.random() * 1000);
    if (!playing && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Pairing / clock invariants as seen by a client (sampled on a few bots to keep CPU down). */
  private check(s: PublicGameState) {
    const byId = new Map(s.players.map((p) => [p.id, p]));
    for (const p of s.players) {
      if (p.status === 'eliminated') {
        if (p.duelPhase) this.violations.push(`${p.id} eliminated but still has a duel clock`);
        continue;
      }
      if (!p.targetId) {
        if (p.duelPhase) this.violations.push(`${p.id} waiting but has a duel clock`);
        continue;
      }
      const o = byId.get(p.targetId);
      if (!o || o.status === 'eliminated' || o.targetId !== p.id) this.violations.push(`${p.id}→${p.targetId} not mutual`);
      else if (o.duelEndsAt !== p.duelEndsAt || o.duelPhase !== p.duelPhase) this.violations.push(`${p.id}/${o.id} clocks differ`);
    }
  }

  private act() {
    const s = this.state;
    const me = s?.players.find((p) => p.id === this.id);
    if (!s || !me || me.status === 'eliminated' || this.sent.size) return;
    const opp = s.players.find((p) => p.id === me.targetId);
    if (!inDuel(me) || !opp) {
      // Deliberately break the rules now and then: the referee must refuse (WR-1).
      if (Math.random() < 0.5) {
        this.illegalSent++;
        this.fire({ type: 'GUESS', word: pick() });
      }
      return;
    }
    if (!clockRunning(me)) return;
    const canSteal = opp.status === 'alive' && (me.status === 'alive' || me.postSolveStealRows > 0);
    if (me.status === 'invulnerable' || (canSteal && Math.random() < 0.25)) {
      if (!canSteal) return;
      this.steals++;
      this.fire({ type: 'STEAL', targetId: opp.id, word: pick() });
    } else {
      this.guesses++;
      this.fire({ type: 'GUESS', word: pick() });
    }
  }

  private fire(a: Record<string, unknown>) {
    this.seq += 1;
    this.sent.set(this.seq, Date.now());
    this.send('action', { ...a, playerId: this.id, clientSeq: this.seq });
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

test('100-agent battle royale stress test over the relay', async ({ page }) => {
  test.setTimeout(600_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });

  const code = await createRoom(page, { nickname: 'host', seed: 9 });
  await page.getByTestId('toggle-early-finish').click(); // controlled by the referee: changes after its round trip
  await expect(page.getByTestId('toggle-early-finish')).not.toBeChecked();
  await page.getByTestId('cap-100').click();
  await expect(page.getByTestId('player-cap-input')).toHaveValue('100');

  const bots = Array.from({ length: BOTS }, (_, i) => new Bot(`bot${String(i).padStart(2, '0')}`, code, i < 3));
  await expect(page.getByTestId('start-hint')).toContainText('100 players ready', { timeout: 60_000 });

  // Host browser CPU / heap through the DevTools protocol.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => {
    const { metrics: m } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(m.map((x) => [x.name, x.value])) as Record<string, number>;
  };
  const before = await metrics();
  const heap: number[] = [];
  const sampler = setInterval(() => {
    void metrics().then((m) => heap.push(m.JSHeapUsedSize ?? 0)).catch(() => {});
  }, 5_000);

  const t0 = Date.now();
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('end-headline')).toBeVisible({ timeout: 540_000 });
  const matchMs = Date.now() - t0;
  clearInterval(sampler);
  const after = await metrics();

  const lat = bots.flatMap((b) => b.latencies).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0;
  const sum = (f: (b: Bot) => number) => bots.reduce((n, b) => n + f(b), 0);
  const rejects: Record<string, number> = {};
  for (const b of bots) for (const [k, v] of Object.entries(b.rejects)) rejects[k] = (rejects[k] ?? 0) + v;
  const busySeconds = (after.TaskDuration ?? 0) - (before.TaskDuration ?? 0);
  const stats = {
    players: 100,
    matchSeconds: Math.round(matchMs / 1000),
    actionsAcked: lat.length,
    guesses: sum((b) => b.guesses),
    steals: sum((b) => b.steals),
    duelsStarted: Math.round(sum((b) => b.duels)),
    illegalWhileWaitingSent: sum((b) => b.illegalSent),
    rejects,
    ackP50: pct(50),
    ackP95: pct(95),
    ackP99: pct(99),
    ackMax: lat.at(-1),
    resyncs: sum((b) => b.resyncs),
    deltasPerBot: Math.round(sum((b) => b.deltas) / BOTS),
    fullSnapshotsPerBot: Math.round(sum((b) => b.fulls) / BOTS),
    kbReceivedPerBot: Math.round(sum((b) => b.bytes) / BOTS / 1024),
    hostMainThreadBusyPct: Math.round((busySeconds / (matchMs / 1000)) * 100),
    hostHeapMB: { start: Math.round((before.JSHeapUsedSize ?? 0) / 1e6), peak: Math.round(Math.max(0, ...heap) / 1e6), end: Math.round((after.JSHeapUsedSize ?? 0) / 1e6) },
    invariantViolations: bots.flatMap((b) => b.violations).length,
    pageErrors: pageErrors.length,
  };
  console.log('LOADTEST', JSON.stringify(stats));
  if (pageErrors.length) console.log('PAGE ERRORS', pageErrors.slice(0, 10));
  if (stats.invariantViolations) console.log('VIOLATIONS', bots.flatMap((b) => b.violations).slice(0, 10));
  await page.screenshot({ path: 'test-results/load-100-end.png', fullPage: true });
  bots.forEach((b) => b.close());

  await expect(page.getByTestId('standings').locator('li')).toHaveCount(100);
  expect(stats.invariantViolations).toBe(0);
  expect(pageErrors).toEqual([]);
  // Every deliberate act-while-waiting was refused (WR-1) — plus any honest action that was in flight
  // when its sender's duel ended (E-28). None got through (no waiting player ever gained a row).
  expect(rejects.waiting_for_opponent ?? 0).toBeGreaterThanOrEqual(stats.illegalWhileWaitingSent);
  expect(stats.actionsAcked).toBeGreaterThan(300);
  expect(stats.ackP95).toBeLessThan(1500);
});
