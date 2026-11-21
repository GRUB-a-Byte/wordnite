import type { TileState } from '@/lib/engine/types';

export type TileLook = 'empty' | 'typed' | 'ghost' | 'pending' | TileState;

const GLYPH: Partial<Record<TileLook, string>> = { correct: '●', present: '◐' };

const LOOK: Record<TileLook, string> = {
  empty: 'border-line/80 bg-[var(--tile-empty)]',
  typed: 'border-[#6b7db0] bg-[var(--tile-empty)] text-ink',
  ghost: 'border-line bg-[var(--tile-empty)] text-muted/70',
  pending: 'border-[#6b7db0] bg-[var(--tile-empty)] text-ink pending-pulse',
  correct: 'tile-correct',
  present: 'tile-present',
  absent: 'tile-absent',
};

export function Tile({
  letter,
  look,
  flipDelayMs,
  pop,
  dashed,
}: {
  letter?: string;
  look: TileLook;
  /** When set, plays the flip reveal with this stagger delay (UI-10). */
  flipDelayMs?: number;
  pop?: boolean;
  dashed?: boolean;
}) {
  const scored = look === 'correct' || look === 'present' || look === 'absent';
  const label = letter ? (scored ? `${letter}, ${look}` : letter) : 'empty';
  return (
    <div
      role="img"
      aria-label={label}
      className={[
        'tile grid place-items-center border-2 font-black uppercase leading-none select-none',
        LOOK[look],
        dashed && look === 'empty' ? 'border-dashed' : '',
        flipDelayMs !== undefined ? 'tile-flip' : '',
        pop ? 'tile-pop' : '',
      ].join(' ')}
      style={flipDelayMs !== undefined ? ({ '--delay': `${flipDelayMs}ms` } as React.CSSProperties) : undefined}
    >
      {letter ?? ''}
      {GLYPH[look] && (
        <span aria-hidden className="cb-glyph absolute top-0.5 right-1 text-[0.4em] leading-none">
          {GLYPH[look]}
        </span>
      )}
    </div>
  );
}
