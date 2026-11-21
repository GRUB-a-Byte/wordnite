'use client';

import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useRoom } from '@/lib/client/store';
import { ThemeToggle } from './ThemeToggle';
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
    <span
      className="flex items-center gap-1.5 text-xs text-muted"
      title={`${label} · realtime: ${transportKind ?? '—'}`}
      data-testid="connection"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
      <span className="hidden lg:inline">{label}</span>
    </span>
  );
}

/**
 * Three-column grid so the centre slot (the timer on phones) is always truly centred, whatever the
 * widths of the left/right clusters.
 */
export function RoomHeader({ center }: { center?: React.ReactNode }) {
  const { roomCode, debug } = useRoom(useShallow((s) => ({ roomCode: s.roomCode, debug: s.debug })));
  return (
    <header className="room-header grid w-full shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 py-1.5 sm:px-4 sm:py-2">
      <Link href="/" className="justify-self-start" aria-label="Home">
        <span className="hidden md:block">
          <Logo size="sm" />
        </span>
        <span className="font-black text-royal-ink md:hidden">WR</span>
      </Link>
      <div className="flex min-w-0 justify-center">{center}</div>
      <div className="flex items-center gap-1.5 justify-self-end sm:gap-2.5">
        <span
          className="rounded-lg bg-blue px-1.5 py-1 font-mono text-[11px] font-bold tracking-widest text-on-accent sm:px-2 sm:text-xs"
          data-testid="room-code-chip"
        >
          {roomCode}
        </span>
        {debug && <span className="hidden rounded bg-shield px-1.5 text-[10px] font-black text-on-accent sm:inline">DEBUG</span>}
        <ConnectionDot />
        <ThemeToggle />
      </div>
    </header>
  );
}
