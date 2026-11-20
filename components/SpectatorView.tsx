'use client';

import { useShallow } from 'zustand/react/shallow';
import { useRoom } from '@/lib/client/store';
import type { ActiveRow } from './Board';
import { Board } from './Board';
import { DebugPanel } from './DebugPanel';
import { fitStyle } from './fit';
import { Banners, CountdownOverlay, OvertimeGod } from './Overlays';
import { RoomHeader } from './RoomHeader';
import { Timer } from './Timer';
import { Toasts } from './Toasts';

/**
 * FR-7.1 spectator / projector view: both boards large, timer and banners, no keyboard. Letters are
 * shown (boards are public); secret words are NOT (FIX 1 — FR-7.2 "dramatic irony" was dropped).
 */
export function SpectatorView() {
  const { game, drafts, watchers } = useRoom(
    useShallow((s) => ({ game: s.game, drafts: s.drafts, watchers: s.game?.spectators.length ?? 0 })),
  );
  if (!game) return null;
  const ghost = (playerId: string): ActiveRow | null => {
    const d = drafts[playerId];
    if (!d || d.matchNumber !== game.matchNumber || !d.letters) return null;
    const t = game.players.find((p) => p.id === d.targetId);
    return { letters: d.letters, look: 'ghost', steal: d.mode === 'steal', label: t ? `→ ${t.nickname}` : undefined };
  };
  const [left, right] = game.players;
  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader center={<span className="text-xs font-bold tracking-widest text-muted uppercase">Spectating</span>} />
      <main className="flex flex-1 flex-col items-center gap-4 px-2 pb-6">
        <Timer size="lg" />
        <div className="flex w-full items-start justify-center gap-3 sm:gap-10" style={fitStyle(game, '--chrome-spectator')}>
          {left && <Board player={left} game={game} viewer="spectator" variant="large" active={ghost(left.id)} />}
          <div className="self-center text-2xl font-black text-muted sm:text-5xl">VS</div>
          {right && <Board player={right} game={game} viewer="spectator" variant="large" active={ghost(right.id)} />}
        </div>
        <p className="text-xs text-muted">{watchers} watching</p>
      </main>
      <Banners />
      <Toasts />
      <CountdownOverlay />
      <OvertimeGod />
      <DebugPanel />
    </div>
  );
}
