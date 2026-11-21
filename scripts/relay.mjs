#!/usr/bin/env node
/**
 * DEV / TEST ONLY — a tiny WebSocket relay that mimics Supabase Realtime Broadcast (`self: true`)
 * and Presence for local development and the Playwright suite. It holds no game logic and no game
 * state: the host browser is still the referee. NOT for production (no auth, no rate limits).
 *
 *   npm run relay            # ws://0.0.0.0:8787
 *   RELAY_PORT=8788 npm run relay
 *
 * Client → relay:  {t:'join', room, key} | {t:'track', meta} | {t:'bc', event, payload}
 * Relay → client:  {t:'joined'} | {t:'presence', members:[meta…]} | {t:'bc', event, payload}
 */
import { WebSocketServer } from 'ws';

// RELAY_PORT for local use; PORT is what hosting platforms (Render, Fly, Railway…) provide.
const port = Number(process.env.RELAY_PORT ?? process.env.PORT ?? 8787);
const wss = new WebSocketServer({ port, maxPayload: 256 * 1024 });
/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();
const HOST_ONLY_EVENTS = new Set(['action', 'sync_request']);

function members(room) {
  const set = rooms.get(room);
  if (!set) return [];
  return [...set].map((ws) => ws.meta).filter(Boolean);
}

function publishPresence(room) {
  const msg = JSON.stringify({ t: 'presence', members: members(room) });
  for (const ws of rooms.get(room) ?? []) if (ws.readyState === ws.OPEN) ws.send(msg);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  // Diagnostics for LAN play: show when another device actually reaches this machine.
  const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (from && from !== '127.0.0.1' && from !== '::1') {
    console.log(`[relay] device connected from ${from}`);
    ws.on('close', () => console.log(`[relay] device ${from} disconnected`));
  }
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'join' && typeof msg.room === 'string' && !ws.room) {
      ws.room = msg.room.slice(0, 32);
      if (!rooms.has(ws.room)) rooms.set(ws.room, new Set());
      rooms.get(ws.room).add(ws);
      ws.send(JSON.stringify({ t: 'joined' }));
      ws.send(JSON.stringify({ t: 'presence', members: members(ws.room) }));
    } else if (msg.t === 'track' && ws.room && msg.meta && typeof msg.meta === 'object') {
      ws.meta = msg.meta;
      publishPresence(ws.room);
    } else if (msg.t === 'bc' && ws.room && typeof msg.event === 'string') {
      const out = JSON.stringify({ t: 'bc', event: msg.event, payload: msg.payload });
      const peers = [...(rooms.get(ws.room) ?? [])];
      // Moves and resync requests are only read by the referee (the host), so deliver them only there:
      // in a 100-player game that is 100x fewer messages per guess. Falls back to everyone if no
      // host has announced itself yet.
      const hostOnly = HOST_ONLY_EVENTS.has(msg.event) ? peers.filter((p) => p.meta?.role === 'host') : [];
      for (const peer of hostOnly.length ? hostOnly : peers) if (peer.readyState === peer.OPEN) peer.send(out);
    }
  });
  ws.on('close', () => {
    if (!ws.room) return;
    const set = rooms.get(ws.room);
    set?.delete(ws);
    if (set && set.size === 0) rooms.delete(ws.room);
    else publishPresence(ws.room);
  });
});

// Drop dead sockets (e.g. a laptop that went to sleep) so presence "leave" fires like Supabase's.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10_000);
wss.on('close', () => clearInterval(heartbeat));

wss.on('listening', () => console.log(`[relay] dev relay listening on ws://0.0.0.0:${port}`));
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[relay] port ${port} is already in use — is the game already running in another terminal?`);
  } else {
    console.error('[relay]', err.message);
  }
  process.exit(1);
});
