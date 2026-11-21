'use client';

import { useShallow } from 'zustand/react/shallow';
import { isBattleRoyale } from '@/lib/engine/state';
import { findPlayer } from '@/lib/client/players';
import { useRoom } from '@/lib/client/store';
import { ArenaBar } from './ArenaBar';
import { ArenaGrid } from './ArenaGrid';
import type { ActiveRow } from './Board';
import { Board } from './Board';
import { DebugPanel } from './DebugPanel';
import { fitVars } from './fit';
import { CountdownOverlay, OvertimeGod, StatusLine } from './Overlays';
import { RoomHeader } from './RoomHeader';
import { Timer } from './Timer';
import { Toasts } from './Toasts';

/**
 * FR-7.1 spectator / projector view: one screen, both boards as large as the screen allows (same
 * fit system as players, bigger header + tile cap), timer and banners, no keyboard. Letters are
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
    const t = findPlayer(game.players, d.targetId);
    return { letters: d.letters, look: 'ghost', steal: d.mode === 'steal', label: t ? `→ ${t.nickname}` : undefined };
  };
  const [left, right] = game.players;
  if (isBattleRoyale(game.players.length)) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <RoomHeader center={<span className="text-xs font-bold tracking-widest text-muted uppercase">Spectating</span>} />
        {/* v1.1 FD-7: no match clock — every duel shows its own clock on its boards. */}
        <div className="flex shrink-0 flex-col items-center px-2">
          <ArenaBar />
          <StatusLine />
        </div>
        <div className="flex min-h-0 flex-1 px-2 pb-2">
          <ArenaGrid game={game} />
        </div>
        <p className="shrink-0 pb-1 text-center text-xs text-muted">
          {game.players.length} players · {watchers} watching
        </p>
        <Toasts />
        <CountdownOverlay />
        <OvertimeGod />
        <DebugPanel />
      </div>
    );
  }
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <RoomHeader center={<span className="text-xs font-bold tracking-widest text-muted uppercase">Spectating</span>} />
      <div className="flex shrink-0 flex-col items-center px-2">
        <Timer size="lg" />
        <StatusLine />
      </div>
      <div className="fit-area min-h-0 flex-1 px-2">
        <div className="fit-row" data-kind="spectator" style={fitVars(game)}>
          {left && <Board player={left} game={game} viewer="spectator" active={ghost(left.id)} />}
          <div className="vs-col font-black text-muted">VS</div>
          {right && <Board player={right} game={game} viewer="spectator" active={ghost(right.id)} />}
        </div>
      </div>
      <p className="shrink-0 pb-1 text-center text-xs text-muted">{watchers} watching</p>
      <Toasts />
      <CountdownOverlay />
      <OvertimeGod />
      <DebugPanel />
    </div>
  );
}
