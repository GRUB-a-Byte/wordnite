import { parsePresenceMeta, type EventName, type PresenceMeta } from './protocol';
import { BaseTransport } from './transport';

/**
 * DEV / TEST ONLY transport talking to scripts/relay.mjs — a ~100-line WebSocket relay that mimics
 * Supabase Broadcast (with `self: true`) + Presence. Lets two browsers (or two Playwright contexts,
 * or phones on the same LAN) play without Supabase credentials. Never used in production builds
 * that have Supabase configured.
 */
export class LocalTransport extends BaseTransport {
  readonly kind = 'local' as const;
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly roomCode: string,
    private readonly presenceKey: string,
  ) {
    super();
    this.connect();
  }

  private url(): string {
    const configured = process.env.NEXT_PUBLIC_LOCAL_RELAY_URL;
    if (configured) return configured;
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return `ws://${host}:8787`;
  }

  private connect(): void {
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', room: this.roomCode, key: this.presenceKey }));
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: { t?: string; event?: string; payload?: unknown; members?: unknown[] };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'joined') {
        this.retry = 0;
        this.setStatus('connected');
      } else if (msg.t === 'bc' && typeof msg.event === 'string') {
        this.emit(msg.event, msg.payload);
      } else if (msg.t === 'presence' && Array.isArray(msg.members)) {
        this.emitPresence(msg.members.map(parsePresenceMeta).filter((m): m is PresenceMeta => m !== null));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUs) return;
      this.setStatus('reconnecting');
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      // onclose follows and handles the retry
    };
  }

  protected rawSend(event: EventName, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'bc', event, payload }));
  }

  protected rawTrack(meta: PresenceMeta): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'track', meta }));
  }

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setStatus('closed');
    this.ws?.close();
    this.ws = null;
  }
}
