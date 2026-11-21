'use client';

import Link from 'next/link';
import { useContext, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isValidRoomCode } from '@/lib/client/ids';
import { getNickname, getPlayerId, isHostOf, setNickname } from '@/lib/client/identity';
import { NICKNAME_MAX, sanitizeNickname } from '@/lib/client/nickname';
import { RoomClient } from '@/lib/client/roomClient';
import { useRoom } from '@/lib/client/store';
import type { PresenceRole, PublicGameState } from '@/lib/engine/types';
import { EndScreen } from './EndScreen';
import { GameView } from './GameView';
import { Lobby } from './Lobby';
import { Logo } from './Logo';
import { RoomClientContext } from './RoomContext';
import { SpectatorView } from './SpectatorView';

interface RoomViewProps {
  code: string;
  watch: boolean;
  big: boolean;
  debug: boolean;
  seed?: number;
  earlyFinish?: boolean;
}

interface Identity {
  pid: string;
  nick: string;
  role: PresenceRole;
}

function resolveIdentity(code: string, watch: boolean): Identity | 'needs-nickname' {
  const pid = getPlayerId();
  const role: PresenceRole = isHostOf(code, pid) ? 'host' : watch ? 'spectator' : 'player';
  const nick = getNickname();
  if (!nick && role === 'player') return 'needs-nickname'; // FR-1.4
  return { pid, nick: nick || (role === 'spectator' ? 'Spectator' : 'Host'), role };
}

export function RoomView({ code, watch, big, debug, seed, earlyFinish }: RoomViewProps) {
  const validCode = isValidRoomCode(code);
  const [identity, setIdentity] = useState<Identity | 'needs-nickname' | null>(null);
  const [client, setClient] = useState<RoomClient | null>(null);

  // Identity comes from browser storage, so it is resolved after mount (no SSR mismatch).
  useEffect(() => {
    if (!validCode) return;
    const t = setTimeout(() => setIdentity(resolveIdentity(code, watch)), 0);
    return () => clearTimeout(t);
  }, [code, watch, validCode]);

  useEffect(() => {
    if (!identity || identity === 'needs-nickname') return;
    const c = new RoomClient({
      roomCode: code,
      playerId: identity.pid,
      nickname: identity.nick,
      role: identity.role,
      debug,
      seed,
      earlyFinish,
    });
    const t = setTimeout(() => setClient(c), 0);
    void c.init();
    return () => {
      clearTimeout(t);
      c.dispose();
    };
  }, [identity, code, debug, seed, earlyFinish]);

  useEffect(() => {
    const root = document.documentElement;
    if (big) root.dataset.big = '1';
    return () => {
      delete root.dataset.big;
    };
  }, [big]);

  if (!validCode) {
    return <Message title="Room not found" body={`“${code}” isn’t a valid room code.`} />;
  }
  if (identity === 'needs-nickname') {
    return (
      <NicknameGate
        code={code}
        onDone={(nick) => {
          setNickname(nick);
          setIdentity(resolveIdentity(code, watch));
        }}
      />
    );
  }
  if (!client) return <Message title="Joining…" body={`Room ${code}`} spinner />;
  return (
    <RoomClientContext.Provider value={client}>
      <RoomScreens />
    </RoomClientContext.Provider>
  );
}

/** Keeps the board view up for a moment after FINISHED so the final animation can play (FR-4.6). */
function useShowEndScreen(game: PublicGameState | null): boolean {
  const sawActiveForMatch = useRef<number | null>(null);
  const finishedKey = game?.phase === 'FINISHED' ? game.matchNumber : null;
  const [readyFor, setReadyFor] = useState<number | null>(null);
  const phase = game?.phase;
  const matchNumber = game?.matchNumber;

  useEffect(() => {
    if (phase === 'COUNTDOWN' || phase === 'PLAYING' || phase === 'OVERTIME') {
      sawActiveForMatch.current = matchNumber ?? null;
    }
  }, [phase, matchNumber]);

  useEffect(() => {
    if (finishedKey === null) return;
    const delay = sawActiveForMatch.current === finishedKey ? 2200 : 0;
    const t = setTimeout(() => setReadyFor(finishedKey), delay);
    return () => clearTimeout(t);
  }, [finishedKey]);

  return finishedKey !== null && readyFor === finishedKey;
}

function RoomScreens() {
  const { configError, roomNotFound, localAbandoned, game, me } = useRoom(
    useShallow((s) => ({
      configError: s.configError,
      roomNotFound: s.roomNotFound,
      localAbandoned: s.localAbandoned,
      game: s.game,
      me: s.me,
    })),
  );
  const showEnd = useShowEndScreen(game);

  if (configError) return <Message title="Realtime not configured" body={configError} />;
  if (localAbandoned || game?.phase === 'ABANDONED') return <Abandoned />;
  if (!game) {
    return roomNotFound ? (
      <Message title="Room not found" body="Nobody is hosting this room. Check the code or create a new room." />
    ) : (
      <Message title="Connecting…" body="Looking for the host" spinner />
    );
  }
  const isPlayer = game.players.some((p) => p.id === me);
  switch (game.phase) {
    case 'LOBBY':
      return <Lobby />;
    case 'COUNTDOWN':
    case 'PLAYING':
    case 'OVERTIME':
      return isPlayer ? <GameView /> : <SpectatorView />;
    case 'FINISHED':
      return showEnd ? <EndScreen /> : isPlayer ? <GameView /> : <SpectatorView />;
    default:
      return null;
  }
}

function Abandoned() {
  const game = useRoom((s) => s.game);
  const me = useRoom((s) => s.me);
  const client = useContext(RoomClientContext);
  const isHost = game?.hostId === me;
  return (
    <Message title="Host left — game abandoned" body="The referee’s browser disconnected for too long.">
      {isHost && game?.phase === 'ABANDONED' && (
        <button
          type="button"
          onClick={() => client?.returnToLobby()}
          className="rounded-xl bg-royal px-5 py-3 font-bold text-on-accent"
        >
          Back to lobby
        </button>
      )}
    </Message>
  );
}

function Message({
  title,
  body,
  spinner,
  children,
}: {
  title: string;
  body?: string;
  spinner?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo />
      {spinner && <span className="h-10 w-10 animate-spin rounded-full border-4 border-line border-t-royal" />}
      <h1 className="text-2xl font-black" data-testid="message-title">
        {title}
      </h1>
      {body && <p className="text-muted">{body}</p>}
      {children}
      <Link href="/" className="font-bold text-royal-2-ink underline">
        Back to home
      </Link>
    </main>
  );
}

function NicknameGate({ code, onDone }: { code: string; onDone: (nick: string) => void }) {
  const [nick, setNick] = useState('');
  const clean = sanitizeNickname(nick);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6">
      <Logo />
      <form
        className="w-full space-y-4 rounded-2xl border border-line bg-panel/80 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) onDone(clean);
        }}
      >
        <p className="text-center text-muted">
          Joining room <span className="font-black tracking-widest text-ink">{code}</span>
        </p>
        <input
          autoFocus
          value={nick}
          onChange={(e) => setNick(e.target.value.slice(0, NICKNAME_MAX))}
          maxLength={NICKNAME_MAX}
          placeholder="Your nickname"
          className="w-full rounded-xl border border-line bg-night px-4 py-3 text-lg font-semibold outline-none focus:border-blue-ink"
          data-testid="gate-nickname"
        />
        <button
          type="submit"
          disabled={!clean}
          className="w-full rounded-xl bg-gradient-to-r from-royal to-blue py-3 text-lg font-black text-on-accent disabled:opacity-50"
          data-testid="gate-join"
        >
          Join game
        </button>
      </form>
    </main>
  );
}
