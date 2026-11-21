'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { shareableRoomUrl } from '@/lib/client/shareUrl';
import { isBattleRoyale, isWaitingForSeat } from '@/lib/engine/state';
import { useRoom } from '@/lib/client/store';
import { DebugPanel } from './DebugPanel';
import { HowToPlay } from './HowToPlay';
import { RoomHeader } from './RoomHeader';
import { useRoomClient } from './RoomContext';
import { useTemporaryFlag } from './hooks';
import { Toasts } from './Toasts';

// Only the lobby needs the QR encoder — keep it out of the shared room bundle (NFR-4).
const QRCodeSVG = dynamic(() => import('qrcode.react').then((mod) => mod.QRCodeSVG), {
  ssr: false,
  loading: () => <div className="h-[176px] w-[176px] animate-pulse rounded bg-line" />,
});

function useRoomUrl(code: string): { url: string; localOnly: boolean } {
  // Rendered only after the client controller mounted, so window is available.
  if (typeof window === 'undefined') return { url: `/room/${code}`, localOnly: false };
  return shareableRoomUrl(window.location, code, process.env.NEXT_PUBLIC_LAN_HOST);
}

const CAP_PRESETS: [number, string][] = [
  [2, 'Duel'],
  [4, '4'],
  [10, '10'],
  [25, '25'],
  [50, '50'],
  [100, '100'],
];

/** Host-only: how many players this room admits (2 = duel … 100 = battle royale). */
function PlayerCapControl({ cap, onChange }: { cap: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    const n = Math.round(Number(raw));
    if (Number.isFinite(n)) onChange(Math.min(100, Math.max(2, n)));
  };
  const step = (d: number) => onChange(Math.min(100, Math.max(2, cap + d)));
  return (
    <div className="space-y-2 rounded-xl bg-panel-2 px-3 py-2.5 text-sm" data-testid="player-cap">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="font-bold">Max players</span>
          <span className="block text-xs text-muted">2 = duel · up to 100 = battle royale. Extra people spectate.</span>
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={cap <= 2}
            className="h-8 w-8 rounded-lg border border-line font-black disabled:opacity-40"
            aria-label="Fewer players"
          >
            −
          </button>
          <input
            type="number"
            min={2}
            max={100}
            inputMode="numeric"
            value={draft ?? String(cap)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            }}
            className="h-8 w-14 rounded-lg border border-line bg-night text-center font-black outline-none focus:border-blue-ink"
            aria-label="Maximum players"
            data-testid="player-cap-input"
          />
          <button
            type="button"
            onClick={() => step(1)}
            disabled={cap >= 100}
            className="h-8 w-8 rounded-lg border border-line font-black disabled:opacity-40"
            aria-label="More players"
          >
            +
          </button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CAP_PRESETS.map(([n, label]) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={cap === n}
            className="rounded-full border border-line px-2.5 py-0.5 text-xs font-bold text-muted transition hover:text-ink aria-pressed:border-blue aria-pressed:bg-blue aria-pressed:text-on-accent"
            data-testid={`cap-${n}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
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
  const { url, localOnly } = useRoomUrl(roomCode);
  const [copied, markCopied] = useTemporaryFlag(1500);
  const [bigQr, setBigQr] = useState(false);
  const [starting, markStarting] = useTemporaryFlag(3000); // one START per click
  if (!game) return null;

  const isHost = game.hostId === me;
  const players = game.players;
  const spectators = game.spectators.filter((s) => s.connected);
  const cap = game.settings.maxPlayers;
  const royale = isBattleRoyale(cap);
  // Any number of players from 2 up to the cap can start — the room does not have to be full.
  const ready = players.length >= 2 && players.every((p) => p.connected);
  const amSpectator = !players.some((p) => p.id === me);
  const meSpectating = game.spectators.find((s) => s.id === me);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      markCopied();
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
          <span className="text-sm text-muted" data-testid="share-url">
            Scan to join · or open {url.replace(/^https?:\/\//, '')}
          </span>
          {localOnly && (
            <p className="max-w-xs rounded-lg bg-shield px-3 py-2 text-xs font-bold text-on-accent" role="alert">
              This link only works on this computer. To let others join, open the game using your network
              address (shown in the terminal by <code>npm run dev:local</code>) or use the deployed site.
            </p>
          )}
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
            <h2 className="mb-2 flex items-baseline justify-between text-xs font-bold tracking-[0.3em] text-muted uppercase">
              <span>
                Players ({players.length}/{cap})
              </span>
              <span className="tracking-normal normal-case">{royale ? '⚔ Battle royale' : 'Duel'}</span>
            </h2>
            <ul
              className={`${players.length > 4 ? 'flex flex-wrap gap-1.5' : 'space-y-2'} max-h-64 overflow-y-auto pr-1`}
              data-testid="player-list"
            >
              {players.map((p) => (
                <li
                  key={p.id}
                  className={`flex items-center gap-2 bg-panel-2 ${players.length > 4 ? 'rounded-full px-2.5 py-1 text-sm' : 'rounded-xl px-3 py-2'}`}
                >
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.connected ? 'bg-correct' : 'bg-steal'}`} />
                  <span className="max-w-[10rem] truncate font-bold">{p.nickname}</span>
                  {p.isHost && <span className="rounded bg-shield px-1.5 text-xs font-bold text-on-accent">★ host</span>}
                  {p.id === me && <span className="text-xs text-muted">(you)</span>}
                </li>
              ))}
              {players.length < cap && players.length <= 4 && (
                <li className="rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted">
                  {royale ? `Room for ${cap - players.length} more…` : 'Waiting for a challenger…'}
                </li>
              )}
            </ul>
            {spectators.length > 0 && (
              <p className="mt-2 text-sm text-muted" data-testid="spectator-count">
                Spectators: {spectators.length}
                {spectators.some(isWaitingForSeat) && ` · ${spectators.filter(isWaitingForSeat).length} waiting for a seat`}
              </p>
            )}
          </div>

          {isHost ? (
            <div className="space-y-3">
              <PlayerCapControl cap={cap} onChange={(n) => client.updateSettings({ maxPlayers: n })} />
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
              {royale && game.settings.enableUnbeatableEarlyFinish && (
                <p className="rounded-lg bg-shield/40 px-3 py-2 text-xs text-ink">
                  Tip: in a big game one lucky early solve can end the match for everyone. Turn early finish off to let
                  the battle royale play out.
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  markStarting(); // the lobby unmounts when the countdown begins
                  client.start();
                }}
                disabled={starting || !ready || !dictionaryReady || connection !== 'connected'}
                className="w-full rounded-xl bg-gradient-to-r from-correct to-royal-2 px-4 py-4 text-xl font-black tracking-wide text-on-accent shadow-lg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="start-game"
              >
                START GAME
              </button>
              <p className="text-center text-sm text-muted" data-testid="start-hint">
                {ready
                  ? `${players.length} player${players.length === 1 ? '' : 's'} ready${players.length < cap ? ` — you can start now or wait for up to ${cap}` : ''}`
                  : 'Need at least 2 players to start.'}
              </p>
            </div>
          ) : (
            <p className="rounded-xl bg-panel-2 px-4 py-3 text-center font-bold text-muted" data-testid="waiting-host">
              {!amSpectator
                ? 'Waiting for the host to start…'
                : meSpectating?.wantsToPlay
                  ? 'The room is full — you’re in line for the next free seat.'
                  : 'You’re spectating.'}
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
