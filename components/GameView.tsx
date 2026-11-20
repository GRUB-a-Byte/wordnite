'use client';

import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { myPlayer, targetOf, useRoom } from '@/lib/client/store';
import type { RoomClient } from '@/lib/client/roomClient';
import { Board, type ActiveRow } from './Board';
import { DebugPanel } from './DebugPanel';
import { fitStyle } from './fit';
import { Keyboard } from './Keyboard';
import { Banners, CountdownOverlay, OvertimeGod } from './Overlays';
import { RoomHeader } from './RoomHeader';
import { useRoomClient } from './RoomContext';
import { Timer } from './Timer';
import { Toasts } from './Toasts';

/** FR-3.1 / FR-4.2: physical keyboard — A–Z, Backspace, Enter, Esc (own mode), Tab (toggle). */
function usePhysicalKeyboard(client: RoomClient) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        client.submit();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        client.backspace();
      } else if (e.key === 'Escape') {
        client.setMode('own');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        client.toggleMode();
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        client.typeLetter(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client]);
}

function useOpponentDraft(playerId: string | undefined): ActiveRow | null {
  return useRoom(
    useShallow((s) => {
      if (!playerId || !s.game) return null;
      const d = s.drafts[playerId];
      if (!d || d.matchNumber !== s.game.matchNumber || !d.letters) return null;
      const target = s.game.players.find((p) => p.id === d.targetId);
      return {
        letters: d.letters,
        look: 'ghost' as const,
        steal: d.mode === 'steal',
        label: d.mode === 'steal' && target ? `→ ${target.nickname}` : undefined,
      };
    }),
  );
}

export function GameView() {
  const client = useRoomClient();
  usePhysicalKeyboard(client);
  const { game, me, mode, draft, pending, shake } = useRoom(
    useShallow((s) => ({
      game: s.game,
      me: myPlayer(s),
      mode: s.mode,
      draft: s.draft,
      pending: s.pending,
      shake: s.shake,
    })),
  );
  const target = useRoom((s) => targetOf(s));
  const oppDraft = useOpponentDraft(target?.id);
  if (!game || !me) return null;

  const attacking = me.status === 'invulnerable' || mode === 'steal';
  const stealBlocked = client.stealBlockReason();
  const label = target ? `→ ${target.nickname}` : undefined;
  const myActive: ActiveRow = pending
    ? { letters: pending.word, look: 'pending', steal: pending.kind === 'steal', label }
    : { letters: draft, look: 'typed', steal: attacking, label: attacking ? label : undefined, shakeKey: shake };

  let oppFooter: React.ReactNode = null;
  if (target) {
    if (target.status === 'invulnerable') oppFooter = '🛡 Shielded — can’t be stolen';
    else if (target.status === 'eliminated') oppFooter = 'Eliminated';
    else if (attacking && !stealBlocked) oppFooter = <span className="font-bold text-steal">⚔ STEAL MODE — type their word</span>;
    else if (!stealBlocked) oppFooter = '(tap to ⚔ STEAL)';
    else oppFooter = stealBlocked;
  }

  let myFooter: React.ReactNode = null;
  if (me.status === 'eliminated') myFooter = 'You’re out — watch the finish';
  else if (me.status === 'invulnerable' && me.postSolveStealRows === 0) myFooter = 'Out of ammo — sit tight, you’re shielded';
  else if (attacking && me.status === 'alive') myFooter = <button type="button" className="underline" onClick={() => client.setMode('own')}>← Back to my board (Esc)</button>;

  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader
        center={
          <div className="md:hidden">
            <Timer size="sm" />
          </div>
        }
      />
      <main className="flex flex-1 flex-col items-center justify-between gap-3">
        <div
          className="flex w-full max-w-6xl items-start justify-center gap-1.5 px-1.5 sm:gap-4 sm:px-4 md:gap-8"
          style={fitStyle(game, '--chrome')}
        >
          <Board
            player={me}
            game={game}
            viewer="me"
            variant="mine"
            active={myActive}
            onActivate={me.status === 'alive' ? () => client.setMode('own') : undefined}
            footer={myFooter}
          />
          <div className="hidden flex-col items-center gap-4 pt-12 md:flex">
            <Timer size="md" />
            <span
              className={`rounded-full px-3 py-1 text-xs font-black tracking-widest uppercase ${
                attacking ? 'bg-steal/20 text-steal' : 'bg-correct/15 text-correct'
              }`}
            >
              {attacking ? '⚔ Stealing' : 'My word'}
            </span>
            <span className="max-w-[9rem] text-center text-[11px] text-muted">Tab switches mode · Esc returns</span>
          </div>
          {target && (
            <Board
              player={target}
              game={game}
              viewer="opponent"
              variant="opp"
              active={oppDraft}
              targeted={attacking && !stealBlocked}
              attackable={!stealBlocked}
              onActivate={() => {
                if (!stealBlocked) client.setMode('steal');
              }}
              footer={oppFooter}
            />
          )}
        </div>
        <div className="safe-bottom sticky bottom-0 flex w-full justify-center bg-gradient-to-t from-night via-night/95 to-transparent px-1.5 pt-3">
          <Keyboard />
        </div>
      </main>
      <Banners />
      <Toasts />
      <CountdownOverlay />
      <OvertimeGod />
      <DebugPanel />
    </div>
  );
}
