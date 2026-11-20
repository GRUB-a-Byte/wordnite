'use client';

import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useRoom } from '@/lib/client/store';
import { Logo } from './Logo';

function ConnectionDot() {
  const { connection, transportKind } = useRoom(
    useShallow((s) => ({ connection: s.connection, transportKind: s.transportKind })),
  );
  const map = {
    connected: ['bg-correct', 'Connected'],
    connecting: ['bg-shield animate-pulse', 'Connecting…'],
    reconnecting: ['bg-shield animate-pulse', 'Reconnecting…'],
    closed: ['bg-steal', 'Disconnected'],
  } as const;
  const [dot, label] = map[connection];
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted" title={`Realtime: ${transportKind ?? '—'}`} data-testid="connection">
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

function ColourBlindToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const on = root.dataset.cb !== '1';
    if (on) root.dataset.cb = '1';
    else delete root.dataset.cb;
    try {
      localStorage.setItem('wr:cb', on ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      onMouseDown={(e) => e.preventDefault()}
      className="rounded-lg border border-line px-2 py-1 text-sm text-muted hover:text-ink"
      title="Colour-blind mode (high contrast + symbols)"
      aria-label="Toggle colour-blind mode"
    >
      ◐
    </button>
  );
}

export function RoomHeader({ center }: { center?: React.ReactNode }) {
  const { roomCode, debug } = useRoom(useShallow((s) => ({ roomCode: s.roomCode, debug: s.debug })));
  return (
    <header className="flex w-full items-center justify-between gap-3 px-3 py-2 sm:px-5">
      <Link href="/" className="shrink-0" aria-label="Home">
        <span className="hidden sm:block">
          <Logo size="sm" />
        </span>
        <span className="font-black text-royal sm:hidden">WR</span>
      </Link>
      <div className="flex flex-1 justify-center">{center}</div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <span className="rounded-lg bg-panel-2 px-2 py-1 font-mono text-xs font-bold tracking-widest" data-testid="room-code-chip">
          {roomCode}
        </span>
        {debug && <span className="rounded bg-shield px-1.5 text-[10px] font-black text-black">DEBUG</span>}
        <ConnectionDot />
        <ColourBlindToggle />
      </div>
    </header>
  );
}
