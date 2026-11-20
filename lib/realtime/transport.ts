import type { EventName, EventPayloads, PresenceMeta } from './protocol';

export type TransportStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * Minimal pub/sub + presence abstraction over a room channel.
 *
 * Production uses Supabase Realtime (Broadcast + Presence). Local development and the Playwright
 * suite can use a tiny WebSocket relay (scripts/relay.mjs) with identical semantics, so the game can
 * be exercised end-to-end without Supabase credentials. The relay is never deployed.
 */
export interface RoomTransport {
  readonly kind: 'supabase' | 'local';
  /** Broadcast to every subscriber of the room, INCLUDING this client (Supabase `self: true`). */
  send<E extends EventName>(event: E, payload: EventPayloads[E]): void;
  on<E extends EventName>(event: E, handler: (payload: unknown) => void): () => void;
  /** Full, de-duplicated member list after every presence change. */
  onPresence(handler: (members: PresenceMeta[]) => void): () => void;
  onStatus(handler: (status: TransportStatus) => void): () => void;
  /** Publishes this client's presence; re-published automatically after every reconnect. */
  track(meta: PresenceMeta): void;
  readonly status: TransportStatus;
  close(): void;
}

export type TransportKind = 'supabase' | 'local';

export function configuredTransportKind(): TransportKind | null {
  const forced = process.env.NEXT_PUBLIC_REALTIME_TRANSPORT;
  if (forced === 'local' || forced === 'supabase') return forced;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return 'supabase';
  // Development fallback: the local relay (npm run relay). Production builds must configure Supabase.
  if (process.env.NODE_ENV !== 'production') return 'local';
  return null;
}

/** Shared base: listener bookkeeping + outbound queue while not connected. */
export abstract class BaseTransport implements RoomTransport {
  abstract readonly kind: TransportKind;
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private presenceListeners = new Set<(members: PresenceMeta[]) => void>();
  private statusListeners = new Set<(status: TransportStatus) => void>();
  private outbox: { event: EventName; payload: unknown }[] = [];
  protected meta: PresenceMeta | null = null;
  protected lastMembers: PresenceMeta[] = [];
  status: TransportStatus = 'connecting';

  protected abstract rawSend(event: EventName, payload: unknown): void;
  protected abstract rawTrack(meta: PresenceMeta): void;
  abstract close(): void;

  send<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    if (this.status === 'connected') {
      this.rawSend(event, payload);
    } else if (event !== 'draft') {
      // Drafts are ephemeral; everything else is queued and flushed on (re)connect.
      this.outbox.push({ event, payload });
      if (this.outbox.length > 50) this.outbox.shift();
    }
  }

  on<E extends EventName>(event: E, handler: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  onPresence(handler: (members: PresenceMeta[]) => void): () => void {
    this.presenceListeners.add(handler);
    return () => this.presenceListeners.delete(handler);
  }

  onStatus(handler: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(handler);
    handler(this.status);
    return () => this.statusListeners.delete(handler);
  }

  track(meta: PresenceMeta): void {
    this.meta = meta;
    if (this.status === 'connected') this.rawTrack(meta);
  }

  protected emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (err) {
        console.error(`[transport] handler for "${event}" failed`, err);
      }
    });
  }

  protected emitPresence(members: PresenceMeta[]): void {
    // De-duplicate by playerId (a refresh can briefly leave two metas for one key).
    const byId = new Map<string, PresenceMeta>();
    for (const m of members) {
      const prev = byId.get(m.playerId);
      if (!prev || m.joinedAt >= prev.joinedAt) byId.set(m.playerId, m);
    }
    this.lastMembers = [...byId.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    this.presenceListeners.forEach((h) => h(this.lastMembers));
  }

  protected setStatus(status: TransportStatus): void {
    if (this.status === status) return;
    this.status = status;
    if (status === 'connected') {
      if (this.meta) this.rawTrack(this.meta);
      const pending = this.outbox.splice(0);
      for (const m of pending) this.rawSend(m.event, m.payload);
    }
    this.statusListeners.forEach((h) => h(status));
  }
}

export async function createTransport(roomCode: string, presenceKey: string): Promise<RoomTransport> {
  const kind = configuredTransportKind();
  if (kind === 'supabase') {
    const { SupabaseTransport } = await import('./supabaseTransport');
    return new SupabaseTransport(roomCode, presenceKey);
  }
  if (kind === 'local') {
    const { LocalTransport } = await import('./localTransport');
    return new LocalTransport(roomCode, presenceKey);
  }
  throw new Error(
    'Realtime is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example).',
  );
}
