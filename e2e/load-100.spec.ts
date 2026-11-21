import { expect, test } from '@playwright/test';
import type { PublicGameState } from '../lib/engine/types';
import { applyDelta, decodeState, type WireDelta, type WireState } from '../lib/realtime/wire';
import { PACKED_ANSWERS } from '../lib/words/answers';
import { createRoom } from './helpers';

/**
 * OPT-IN load test (LOADTEST=1): one real browser host + 99 bot players over the local relay.
 * Bots join through Presence, follow the game exactly like RoomClient (full snapshot + deltas, resync
 * on gaps) and guess every ~2.5 s, so they run out of rows; the host survives and wins. Measures
 * submit → authoritative-ack latency, resyncs and bytes received. Does NOT exercise Supabase.
 *
 *   LOADTEST=1 npx playwright test e2e/load-100.spec.ts
 */
test.skip(!process.env.LOADTEST, 'opt-in: set LOADTEST=1');

const RELAY = `ws://localhost:${process.env.E2E_RELAY_PORT ?? 8788}`;
const BOTS = 99;
const WORDS = Array.from({ length: PACKED_ANSWERS.length / 5 }, (_, i) => PACKED_ANSWERS.slice(i * 5, i * 5 + 5));

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
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly id: string,
    readonly room: string,
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
    if (msg.event === 'state') {
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
    this.state = s;
    const me = s.players.find((p) => p.id === this.id);
    if (!me) return;
    for (const [seq, at] of this.sent) {
      if (me.lastSeq >= seq) {
        this.latencies.push(Date.now() - at);
        this.sent.delete(seq);
      }
    }
    const playing = s.phase === 'PLAYING' || s.phase === 'OVERTIME';
    if (playing && !this.timer) {
      this.timer = setInterval(() => this.act(), 2000 + Math.random() * 1000);
    }
    if (!playing && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private act() {
    const me = this.state?.players.find((p) => p.id === this.id);
    if (!me || me.status !== 'alive' || this.sent.size) return;
    this.seq += 1;
    this.sent.set(this.seq, Date.now());
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    this.send('action', { type: 'GUESS', playerId: this.id, clientSeq: this.seq, word });
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

test('100-player battle royale over the relay', async ({ page }) => {
  test.setTimeout(240_000);
  const code = await createRoom(page, { nickname: 'host', seed: 9 });
  await page.getByTestId('toggle-early-finish').click(); // controlled by the referee: changes after its round trip
  await expect(page.getByTestId('toggle-early-finish')).not.toBeChecked();
  await page.getByTestId('cap-100').click();
  await expect(page.getByTestId('player-cap-input')).toHaveValue('100');

  const bots = Array.from({ length: BOTS }, (_, i) => new Bot(`bot${String(i).padStart(2, '0')}`, code));
  await expect(page.getByTestId('start-hint')).toContainText('100 players ready', { timeout: 60_000 });
  const t0 = Date.now();
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('end-headline')).toBeVisible({ timeout: 120_000 });
  const matchMs = Date.now() - t0;

  const lat = bots.flatMap((b) => b.latencies).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0;
  const stats = {
    players: 100,
    matchSeconds: Math.round(matchMs / 1000),
    guessesAcked: lat.length,
    ackP50: pct(50),
    ackP95: pct(95),
    ackMax: lat.at(-1),
    resyncs: bots.reduce((n, b) => n + b.resyncs, 0),
    deltasPerBot: Math.round(bots.reduce((n, b) => n + b.deltas, 0) / BOTS),
    fullSnapshotsPerBot: Math.round(bots.reduce((n, b) => n + b.fulls, 0) / BOTS),
    kbReceivedPerBot: Math.round(bots.reduce((n, b) => n + b.bytes, 0) / BOTS / 1024),
  };
  console.log('LOADTEST', JSON.stringify(stats));
  await page.screenshot({ path: 'test-results/load-100-end.png', fullPage: true });
  bots.forEach((b) => b.close());

  await expect(page.getByTestId('standings').locator('li')).toHaveCount(100);
  expect(stats.guessesAcked).toBeGreaterThan(300);
  expect(stats.ackP95).toBeLessThan(1500);
});
