import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { EVENT_NAMES, parsePresenceMeta, type EventName, type PresenceMeta } from './protocol';
import { BaseTransport } from './transport';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set');
    // No auth, no database: Realtime Broadcast + Presence only (SRS §8.1, NFR-15).
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}

/**
 * Supabase Realtime transport: one channel `room:{CODE}` with Broadcast (`self: true`, so the
 * host's own actions travel the same path as guests' — fair FIFO ordering) and Presence keyed by
 * playerId.
 */
export class SupabaseTransport extends BaseTransport {
  readonly kind = 'supabase' as const;
  private channel: RealtimeChannel;
  private closedByUs = false;

  constructor(roomCode: string, presenceKey: string) {
    super();
    const supabase = getClient();
    this.channel = supabase.channel(`room:${roomCode}`, {
      config: {
        broadcast: { self: true, ack: false },
        presence: { key: presenceKey, enabled: true },
      },
    });
    for (const event of EVENT_NAMES) {
      this.channel.on('broadcast', { event }, (msg: { payload?: unknown }) => this.emit(event, msg.payload));
    }
    this.channel.on('presence', { event: 'sync' }, () => this.syncPresence());
    this.channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') this.setStatus('connected');
      else if (status === 'CLOSED') this.setStatus(this.closedByUs ? 'closed' : 'reconnecting');
      else this.setStatus('reconnecting'); // CHANNEL_ERROR / TIMED_OUT — realtime-js rejoins automatically
    });
  }

  private syncPresence(): void {
    const state = this.channel.presenceState<Record<string, unknown>>();
    const members: PresenceMeta[] = [];
    for (const metas of Object.values(state)) {
      for (const raw of metas) {
        const meta = parsePresenceMeta(raw);
        if (meta) members.push(meta);
      }
    }
    this.emitPresence(members);
  }

  protected rawSend(event: EventName, payload: unknown): void {
    void this.channel.send({ type: 'broadcast', event, payload }).then((res) => {
      if (res !== 'ok') console.warn(`[supabase] send "${event}" → ${res}`);
    });
  }

  protected rawTrack(meta: PresenceMeta): void {
    void this.channel.track({ ...meta });
  }

  close(): void {
    this.closedByUs = true;
    this.setStatus('closed');
    void getClient().removeChannel(this.channel);
  }
}
