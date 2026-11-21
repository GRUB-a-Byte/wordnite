'use client';

import { useShallow } from 'zustand/react/shallow';
import { keyStates, rowsScoredAgainst } from '@/lib/client/keyboard';
import { myPlayer, targetOf, useRoom } from '@/lib/client/store';
import type { TileState } from '@/lib/engine/types';
import { useRoomClient } from './RoomContext';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', '+ZXCVBNM-'];

const KEY_LOOK: Record<TileState | 'none', string> = {
  none: 'bg-panel-2 text-ink border-line hover:bg-[#222d52]',
  correct: 'tile-correct',
  present: 'tile-present',
  absent: 'tile-absent opacity-70',
};

/** FR-3.1 on-screen keyboard + FR-3.5 key colours for the CURRENT mode's target + mode toggle. */
export function Keyboard() {
  const client = useRoomClient();
  const { game, me, mode, pending } = useRoom(
    useShallow((s) => ({ game: s.game, me: myPlayer(s), mode: s.mode, pending: s.pending })),
  );
  const target = useRoom((s) => targetOf(s));
  if (!game || !me) return null;

  const attacking = mode === 'steal' || me.status === 'invulnerable';
  const subject = attacking ? target : me;
  const states = subject ? keyStates(rowsScoredAgainst(subject, game.players)) : {};
  const stealBlocked = client.stealBlockReason();
  const canType = client.canType();

  const press = (k: string) => {
    if (k === '+') client.submit();
    else if (k === '-') client.backspace();
    else client.typeLetter(k);
  };

  return (
    <div className="w-full max-w-2xl select-none" data-testid="keyboard">
      <div className="mb-2 flex items-center justify-center gap-2" role="group" aria-label="Input mode">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => client.setMode('own')}
          disabled={me.status !== 'alive'}
          aria-pressed={!attacking}
          className={`rounded-full border px-3 py-1.5 text-xs font-black tracking-wide uppercase transition sm:text-sm ${
            !attacking ? 'border-correct bg-correct/20 text-correct' : 'border-line text-muted hover:text-ink'
          } disabled:opacity-40`}
          data-testid="mode-own"
        >
          My word
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => client.setMode('steal')}
          disabled={!!stealBlocked}
          title={stealBlocked ?? 'Space or Tab to toggle'}
          aria-pressed={attacking}
          className={`rounded-full border px-3 py-1.5 text-xs font-black tracking-wide uppercase transition sm:text-sm ${
            attacking ? 'border-steal bg-steal/20 text-steal' : 'border-line text-muted hover:text-ink'
          } disabled:opacity-40`}
          data-testid="mode-steal"
        >
          ⚔ Steal {target ? `· ${target.nickname}` : ''}
        </button>
        {stealBlocked && me.status !== 'eliminated' && (
          <span className="text-[11px] text-muted">{stealBlocked}</span>
        )}
        {/* FR-4.2a.4: key hint, only where a physical keyboard is likely (fine pointer). */}
        {!stealBlocked && me.status === 'alive' && (
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] font-bold text-muted [@media(pointer:fine)]:inline">
            Space ⇄
          </kbd>
        )}
      </div>

      <div className={`flex flex-col gap-1.5 ${canType ? '' : 'opacity-50'}`}>
        {ROWS.map((row) => (
          <div key={row} className="flex justify-center gap-1 sm:gap-1.5">
            {row.split('').map((k) => {
              const wide = k === '+' || k === '-';
              const look = wide ? 'none' : (states[k] ?? 'none');
              return (
                <button
                  key={k}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => press(k)}
                  disabled={!canType || (k === '+' && !!pending)}
                  aria-label={k === '+' ? 'Enter' : k === '-' ? 'Backspace' : `${k}${look !== 'none' ? `, ${look}` : ''}`}
                  className={`grid h-12 place-items-center rounded-md border text-sm font-black uppercase transition active:scale-95 sm:h-14 sm:text-base ${
                    wide ? 'min-w-[3.3rem] px-2 text-[11px] sm:min-w-[4.5rem] sm:text-xs' : 'w-[8.4vw] max-w-11'
                  } ${KEY_LOOK[look]} ${k === '+' && attacking ? 'border-steal bg-steal/25' : ''}`}
                >
                  {k === '+' ? (attacking ? 'STEAL' : 'ENTER') : k === '-' ? '⌫' : k}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
