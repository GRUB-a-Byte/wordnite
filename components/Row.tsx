'use client';

import { useEffect, useState } from 'react';
import type { Row as RowData } from '@/lib/engine/types';
import { hasRevealed, markRevealed } from '@/lib/client/revealed';
import { Tile, type TileLook } from './Tile';

const STAGGER_MS = 100;

function Frame({
  steal,
  label,
  hit,
  children,
  className = '',
}: {
  steal?: boolean;
  label?: string;
  hit?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative flex items-center ${className}`}>
      {/* UI-6 steal row: red frame + ⚔ in the side margin + target label. The frame is an outline,
          so it takes no layout space (the fit system counts rows as exactly one tile tall). */}
      <span
        aria-hidden
        className={`absolute -left-[1.15em] w-[1em] text-center text-[calc(var(--tile-size,var(--tile))*0.34)] ${steal ? 'text-steal-ink' : 'opacity-0'}`}
      >
        ⚔
      </span>
      <div
        className={`tile-gap flex rounded-[calc(var(--tile-size,var(--tile))*0.14)] ${
          steal ? 'outline-2 outline-offset-2 outline-steal-ink' : ''
        } ${hit ? 'glow-correct' : ''}`}
      >
        {children}
      </div>
      {label && (
        <span className="steal-label pointer-events-none absolute -top-2 -right-1 z-10 max-w-[70%] truncate rounded bg-steal px-1 py-px text-[9px] leading-none font-bold whitespace-nowrap text-on-accent sm:text-[10px]">
          {label}
        </span>
      )}
    </div>
  );
}

/** A submitted, scored row. Flips once, the first time it is seen in this tab. */
export function ScoredRow({ row, length, label }: { row: RowData; length: number; label?: string }) {
  const [animate] = useState(() => !hasRevealed(row.id));
  useEffect(() => {
    markRevealed([row.id]);
  }, [row.id]);
  return (
    <Frame steal={row.kind === 'steal'} label={label} hit={row.hit}>
      {Array.from({ length }, (_, i) => (
        <Tile
          key={i}
          letter={row.word[i]}
          look={row.tiles[i] ?? 'absent'}
          flipDelayMs={animate ? i * STAGGER_MS : undefined}
        />
      ))}
    </Frame>
  );
}

/** Draft (typing), pending (sent, awaiting the referee), mirrored opponent draft, or empty. */
export function OpenRow({
  letters,
  length,
  look,
  steal,
  label,
  shakeKey,
  dashed,
}: {
  letters: string;
  length: number;
  look: Extract<TileLook, 'typed' | 'ghost' | 'pending' | 'empty'>;
  steal?: boolean;
  label?: string;
  shakeKey?: number;
  dashed?: boolean;
}) {
  return (
    <Frame steal={steal} label={label} className={shakeKey ? 'row-shake' : ''} key={shakeKey}>
      {Array.from({ length }, (_, i) => {
        const ch = letters[i];
        return (
          <Tile
            key={i}
            letter={ch}
            look={ch ? look : 'empty'}
            pop={look === 'typed' && !!ch && i === letters.length - 1}
            dashed={dashed}
          />
        );
      })}
    </Frame>
  );
}
