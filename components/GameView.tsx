'use client';

import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isBattleRoyale } from '@/lib/engine/state';
import { findPlayer } from '@/lib/client/players';
import { myPlayer, targetOf, useRoom } from '@/lib/client/store';
import type { RoomClient } from '@/lib/client/roomClient';
import { ArenaBar } from './ArenaBar';
import { Board, type ActiveRow } from './Board';
import { DebugPanel } from './DebugPanel';
import { fitVars } from './fit';
import { Keyboard } from './Keyboard';
import { CountdownOverlay, OvertimeGod, StatusLine } from './Overlays';
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
      const target = findPlayer(s.game.players, d.targetId);
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

  // One contextual hint (replaces the old per-board footers, so both boards stay identical).
  let hint: React.ReactNode = null;
  const royale = isBattleRoyale(game.players.length);
  if (me.status === 'eliminated') hint = royale ? 'You’re out — watching the rest of the battle' : 'You’re out — watch the finish';
  else if (royale && !target)
    hint = me.status === 'alive' ? '⏳ Waiting for a free opponent — keep solving your word' : '🛡 You’re safe — no opponent left to attack';
  else if (me.status === 'invulnerable' && me.postSolveStealRows === 0) hint = 'Out of ammo — you’re shielded, sit tight';
  else if (target?.status === 'invulnerable') hint = `🛡 ${target.nickname} is shielded — keep solving your own word`;
  else if (stealBlocked && attacking) hint = stealBlocked;
  else if (attacking && target) hint = `⚔ Steal mode — type ${target.nickname}’s word · Esc to go back`;
  else if (target && !stealBlocked) hint = `Guess your word · tap ${target.nickname}’s board (or Tab) to steal`;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <RoomHeader
        center={
          <div className="only-compact">
            <Timer size="sm" />
          </div>
        }
      />
      <ArenaBar />
      <main className="game-main flex min-h-0 flex-1 flex-col">
        <div className="fit-area flex-1 px-1.5 sm:px-3">
          <div className="fit-row" data-kind="player" style={fitVars(game)}>
            <Board
              player={me}
              game={game}
              viewer="me"
              active={myActive}
              onActivate={me.status === 'alive' ? () => client.setMode('own') : undefined}
            />
            <div className="only-wide center-col flex-col items-center gap-3 self-center">
              <Timer size="md" />
              <span
                className={`rounded-full px-3 py-1 text-xs font-black tracking-widest whitespace-nowrap uppercase ${
                  attacking ? 'bg-steal text-on-accent' : 'bg-correct text-on-accent'
                }`}
              >
                {attacking ? '⚔ Stealing' : 'My word'}
              </span>
            </div>
            {target ? (
              <Board
                key={target.id /* a new target gets a fresh board (and its own flip animations) */}
                player={target}
                game={game}
                viewer="opponent"
                active={oppDraft}
                targeted={attacking && !stealBlocked}
                attackable={!stealBlocked}
                onActivate={() => {
                  if (!stealBlocked) client.setMode('steal');
                }}
              />
            ) : (
              <div className="board-pad flex w-[calc(var(--tile-size)*6.24)] shrink-0 flex-col items-center justify-center self-stretch rounded-2xl border border-dashed border-line text-center text-[length:var(--bh-name)] font-bold text-muted">
                {me.status === 'alive' ? (
                  <span data-testid="waiting-opponent">
                    ⏳ Waiting for an opponent
                    <span className="mt-1 block text-[length:var(--bh-meta)] font-semibold">
                      You’ll be paired as soon as someone is free. Nobody can steal from you meanwhile.
                    </span>
                  </span>
                ) : (
                  'No opponent left — you’re safe'
                )}
              </div>
            )}
          </div>
        </div>
        <div className="game-dock safe-bottom relative flex shrink-0 flex-col items-center px-1.5 pt-1 sm:px-3">
          <Toasts placement="dock" />
          <StatusLine hint={hint} />
          <Keyboard />
        </div>
      </main>
      <CountdownOverlay />
      <OvertimeGod />
      <DebugPanel />
    </div>
  );
}
