'use client';

import { useShallow } from 'zustand/react/shallow';
import { keyStates, rowsScoredAgainst } from '@/lib/client/keyboard';
import { myPlayer, targetOf, useRoom } from '@/lib/client/store';
import type { TileState } from '@/lib/engine/types';
import { useRoomClient } from './RoomContext';

// '+' = Enter, '-' = Backspace, '.' = half-key spacer (centres the shorter middle row).
const ROWS = ['QWERTYUIOP', '.ASDFGHJKL.', '+ZXCVBNM-'];

const KEY_LOOK: Record<TileState | 'none', string> = {
  none: 'key-unused hover:brightness-105',
  correct: 'tile-correct',
  present: 'tile-present',
  absent: 'key-absent',
};

/**
 * FR-3.1 on-screen keyboard + FR-3.5 key colours for the CURRENT mode's target + mode toggle.
 * Keys flex to the available width and take their height from --key-h, so the keyboard fits any
 * phone (portrait or landscape), tablet or desktop without overflowing.
 */
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

  const modeBtn =
    'min-w-0 truncate rounded-full border px-3 py-1 text-[clamp(11px,1.6vmin,14px)] font-black tracking-wide uppercase transition disabled:opacity-40';

  return (
    <div className="flex w-full max-w-[36rem] flex-col gap-[clamp(4px,0.8vmin,8px)] select-none" data-testid="keyboard">
      <div className="flex items-center justify-center gap-2" role="group" aria-label="Input mode">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => client.setMode('own')}
          disabled={me.status !== 'alive'}
          aria-pressed={!attacking}
          className={`${modeBtn} ${
            !attacking ? 'border-correct bg-correct text-on-accent' : 'border-line text-muted hover:border-blue-ink/60 hover:text-ink'
          }`}
          data-testid="mode-own"
        >
          My word
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => client.setMode('steal')}
          disabled={!!stealBlocked}
          title={stealBlocked ?? 'Tab to toggle'}
          aria-pressed={attacking}
          className={`${modeBtn} max-w-[60%] ${
            attacking ? 'border-steal bg-steal text-on-accent' : 'border-line text-muted hover:border-blue-ink/60 hover:text-ink'
          }`}
          data-testid="mode-steal"
        >
          ⚔ Steal{target ? ` · ${target.nickname}` : ''}
        </button>
      </div>

      <div className={`flex flex-col gap-[clamp(4px,0.7vmin,7px)] ${canType ? '' : 'opacity-50'}`}>
        {ROWS.map((row) => (
          <div key={row} className="flex w-full justify-center gap-[clamp(3px,0.7vmin,6px)]">
            {row.split('').map((k, idx) => {
              if (k === '.') return <span key={`sp${idx}`} aria-hidden className="flex-[0.5]" />;
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
                  className={`grid h-[var(--key-h)] min-w-0 place-items-center rounded-md border font-black uppercase transition active:scale-95 ${
                    wide
                      ? 'flex-[1.55] text-[clamp(10px,calc(var(--key-h)*0.26),14px)]'
                      : 'flex-1 text-[clamp(12px,calc(var(--key-h)*0.38),20px)]'
                  } ${k === '+' && attacking ? 'border-steal bg-steal text-on-accent' : KEY_LOOK[look]}`}
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
