'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRoom } from '@/lib/client/store';
import { DebugPanel } from './DebugPanel';
import { HowToPlay } from './HowToPlay';
import { RoomHeader } from './RoomHeader';
import { useRoomClient } from './RoomContext';
import { Toasts } from './Toasts';

// Only the lobby needs the QR encoder — keep it out of the shared room bundle (NFR-4).
const QRCodeSVG = dynamic(() => import('qrcode.react').then((mod) => mod.QRCodeSVG), {
  ssr: false,
  loading: () => <div className="h-[176px] w-[176px] animate-pulse rounded bg-line" />,
});

function useRoomUrl(code: string): string {
  // Rendered only after the client controller mounted, so window is available.
  return typeof window === 'undefined' ? `/room/${code}` : `${window.location.origin}/room/${code}`;
}

/** FR-2.1 … FR-2.5: code, QR, roster, host-only Start, how-to-play. */
export function Lobby() {
  const client = useRoomClient();
  const { game, me, roomCode, dictionaryReady, connection } = useRoom(
    useShallow((s) => ({
      game: s.game,
      me: s.me,
      roomCode: s.roomCode,
      dictionaryReady: s.dictionaryReady,
      connection: s.connection,
    })),
  );
  const url = useRoomUrl(roomCode);
  const [copied, setCopied] = useState(false);
  const [bigQr, setBigQr] = useState(false);
  const [starting, setStarting] = useState(false);
  if (!game) return null;

  const isHost = game.hostId === me;
  const players = game.players;
  const spectators = game.spectators.filter((s) => s.connected);
  const ready = players.length === game.settings.maxPlayers && players.every((p) => p.connected);
  const amSpectator = !players.some((p) => p.id === me);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      client.toast(url, 'info');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader />
      <main className="mx-auto grid w-full max-w-5xl flex-1 gap-5 px-4 pb-8 md:grid-cols-[1fr_1fr] md:items-start">
        <section className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-panel/70 p-5 text-center">
          <span className="text-xs font-bold tracking-[0.3em] text-muted uppercase">Room code</span>
          <span className="text-6xl font-black tracking-[0.25em] sm:text-7xl" data-testid="room-code">
            {roomCode}
          </span>
          <button
            type="button"
            onClick={() => setBigQr(true)}
            className="rounded-2xl bg-white p-3 shadow-xl transition hover:scale-[1.02]"
            aria-label="Show QR code fullscreen"
          >
            <QRCodeSVG value={url} size={176} marginSize={0} />
          </button>
          <span className="text-sm text-muted">Scan to join · or open {url.replace(/^https?:\/\//, '')}</span>
          <button
            type="button"
            onClick={copy}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-bold text-muted hover:text-ink"
          >
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </section>

        <section className="flex flex-col gap-4 rounded-2xl border border-line bg-panel/70 p-5">
          <div>
            <h2 className="mb-2 text-xs font-bold tracking-[0.3em] text-muted uppercase">
              Players ({players.length}/{game.settings.maxPlayers})
            </h2>
            <ul className="space-y-2" data-testid="player-list">
              {players.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-xl bg-panel-2 px-3 py-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${p.connected ? 'bg-correct' : 'bg-steal'}`} />
                  <span className="font-bold">{p.nickname}</span>
                  {p.isHost && <span className="rounded bg-shield/20 px-1.5 text-xs font-bold text-shield">★ host</span>}
                  {p.id === me && <span className="text-xs text-muted">(you)</span>}
                </li>
              ))}
              {players.length < game.settings.maxPlayers && (
                <li className="rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted">
                  Waiting for a challenger…
                </li>
              )}
            </ul>
            {spectators.length > 0 && (
              <p className="mt-2 text-sm text-muted" data-testid="spectator-count">
                Spectators: {spectators.length}
              </p>
            )}
          </div>

          {isHost ? (
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-3 rounded-xl bg-panel-2 px-3 py-2 text-sm">
                <span>
                  <span className="font-bold">Unbeatable early finish</span>
                  <span className="block text-xs text-muted">End as soon as the unsolved player can’t win (GR-28)</span>
                </span>
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-royal"
                  checked={game.settings.enableUnbeatableEarlyFinish}
                  onChange={(e) => client.updateSettings({ enableUnbeatableEarlyFinish: e.target.checked })}
                  data-testid="toggle-early-finish"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  setStarting(true); // one START per click; the lobby unmounts when the countdown begins
                  client.start();
                  setTimeout(() => setStarting(false), 3000);
                }}
                disabled={starting || !ready || !dictionaryReady || connection !== 'connected'}
                className="w-full rounded-xl bg-gradient-to-r from-correct to-royal-2 px-4 py-4 text-xl font-black tracking-wide text-night shadow-lg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="start-game"
              >
                START GAME
              </button>
              {!ready && <p className="text-center text-sm text-muted">Need exactly 2 connected players.</p>}
            </div>
          ) : (
            <p className="rounded-xl bg-panel-2 px-4 py-3 text-center font-bold text-muted" data-testid="waiting-host">
              {amSpectator ? 'You’re spectating this match.' : 'Waiting for the host to start…'}
            </p>
          )}

          <div className="rounded-xl border border-line/60 p-4">
            <h3 className="mb-2 text-xs font-bold tracking-[0.3em] text-muted uppercase">How to play</h3>
            <HowToPlay compact settings={game.settings} />
          </div>
          <p className="text-center text-xs text-muted">
            {Math.round(game.settings.matchMs / 1000)} s match · {Math.round(game.settings.overtimeMs / 1000)} s overtime ·{' '}
            {game.settings.baseRows} rows
          </p>
        </section>
      </main>

      {bigQr && (
        <button
          type="button"
          className="fixed inset-0 z-50 grid place-items-center bg-night/95 p-6"
          onClick={() => setBigQr(false)}
          aria-label="Close QR code"
        >
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-3xl bg-white p-6">
              <QRCodeSVG value={url} size={Math.min(720, 600)} style={{ width: 'min(80vw, 80vh)', height: 'auto' }} />
            </div>
            <span className="text-5xl font-black tracking-[0.3em]">{roomCode}</span>
          </div>
        </button>
      )}
      <Toasts />
      <DebugPanel />
    </div>
  );
}
