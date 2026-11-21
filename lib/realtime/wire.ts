import type { PublicGameState, PublicPlayer, Row, TileState } from '@/lib/engine/types';

/**
 * Wire format for game-state broadcasts — built for 100-player battle royales.
 *
 *  1. COMPACT ROWS: a row travels as a tuple, its five tile states as a 5-char code
 *     (["m1-r7","CRANE","cpaac",3,"pid",1732150000000] instead of ~200 bytes of JSON).
 *  2. DELTAS: after the first full snapshot the host sends only what changed since the previous
 *     broadcast — the players whose record changed plus changed top-level fields. A guess in a
 *     100-player game costs ~1 KB instead of ~60–80 KB. Each delta names the version it applies
 *     to (`base`); a client that missed one detects the gap and asks for a full snapshot.
 *
 * Secrets never appear in either form (the input is already a redacted PublicGameState).
 */

const T2C: Record<TileState, string> = { correct: 'c', present: 'p', absent: 'a' };
const C2T: Record<string, TileState> = { c: 'correct', p: 'present', a: 'absent' };

/** [id, word, tiles, flags (1 = steal, 2 = scoring, 4 = hit), targetId, at] */
export type WireRow = [string, string, string, number, string, number];
export type WirePlayer = Omit<PublicPlayer, 'rows'> & { rows: WireRow[] };
export type WireState = Omit<PublicGameState, 'players'> & { players: WirePlayer[] };

export interface WireDelta {
  /** Version this delta applies on top of. */
  base: number;
  /** Version after applying (== base for a clock-only heartbeat). */
  v: number;
  hostNow: number;
  /** Changed top-level fields; null means "removed". */
  top?: Record<string, unknown>;
  /** Full records of players that changed or joined. */
  players?: WirePlayer[];
  /** New player order — present only when players joined / left / reordered. */
  order?: string[];
}

export function encodeRow(r: Row): WireRow {
  const flags = (r.kind === 'steal' ? 1 : 0) | (r.scoring ? 2 : 0) | (r.hit ? 4 : 0);
  return [r.id, r.word, r.tiles.map((t) => T2C[t]).join(''), flags, r.targetId, r.at];
}

export function decodeRow([id, word, tiles, flags, targetId, at]: WireRow): Row {
  return {
    id,
    word,
    tiles: tiles.split('').map((c) => C2T[c] ?? 'absent'),
    kind: flags & 1 ? 'steal' : 'own',
    scoring: !!(flags & 2),
    hit: !!(flags & 4),
    targetId,
    at,
  };
}

export function encodePlayer(p: PublicPlayer): WirePlayer {
  return { ...p, rows: p.rows.map(encodeRow) };
}

export function decodePlayer(p: WirePlayer): PublicPlayer {
  return { ...p, rows: p.rows.map(decodeRow) };
}

export function encodeState(s: PublicGameState): WireState {
  return { ...s, players: s.players.map(encodePlayer) };
}

export function decodeState(s: WireState): PublicGameState {
  return { ...s, players: s.players.map(decodePlayer) };
}

const SKIP_TOP = new Set(['players', 'version', 'hostNow']);

/** Changes needed to turn `prev` into `next` (both already wire-encoded). */
export function makeDelta(prev: WireState, next: WireState): WireDelta {
  const delta: WireDelta = { base: prev.version, v: next.version, hostNow: next.hostNow };

  const top: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (SKIP_TOP.has(key)) continue;
    const a = (prev as unknown as Record<string, unknown>)[key];
    const b = (next as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) top[key] = b === undefined ? null : b;
  }
  if (Object.keys(top).length) delta.top = top;

  const before = new Map(prev.players.map((p) => [p.id, JSON.stringify(p)]));
  const changed = next.players.filter((p) => before.get(p.id) !== JSON.stringify(p));
  if (changed.length) delta.players = changed;

  const order = next.players.map((p) => p.id);
  if (order.length !== prev.players.length || order.some((id, i) => prev.players[i]?.id !== id)) delta.order = order;
  return delta;
}

/**
 * Applies a delta to the client's current (decoded) state. Returns null when the delta does not
 * apply to `cur` (missed update) — the caller should request a full snapshot.
 */
export function applyDelta(cur: PublicGameState, d: WireDelta): PublicGameState | null {
  if (cur.version !== d.base) return null;
  const next = { ...cur, version: d.v, hostNow: d.hostNow } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(d.top ?? {})) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const byId = new Map(cur.players.map((p) => [p.id, p]));
  for (const p of d.players ?? []) byId.set(p.id, decodePlayer(p));
  const order = d.order ?? cur.players.map((p) => p.id);
  const players: PublicPlayer[] = [];
  for (const id of order) {
    const p = byId.get(id);
    if (!p) return null; // inconsistent delta — resync
    players.push(p);
  }
  next.players = players;
  return next as unknown as PublicGameState;
}

export function isWireDelta(raw: unknown): raw is WireDelta {
  if (typeof raw !== 'object' || raw === null) return false;
  const d = raw as Record<string, unknown>;
  return (
    typeof d.base === 'number' &&
    typeof d.v === 'number' &&
    typeof d.hostNow === 'number' &&
    (d.players === undefined || Array.isArray(d.players)) &&
    (d.order === undefined || Array.isArray(d.order)) &&
    (d.top === undefined || (typeof d.top === 'object' && d.top !== null))
  );
}
