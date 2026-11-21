import { DEFAULT_SETTINGS } from '@/lib/engine/settings';
import { isBattleRoyale } from '@/lib/engine/state';
import type { GameSettings } from '@/lib/engine/types';

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`;
}

/** FR-2.5 / NFR-10: the whole ruleset in five bullets (numbers come from GameSettings, NFR-12). */
export function HowToPlay({ compact = false, settings = DEFAULT_SETTINGS }: { compact?: boolean; settings?: GameSettings }) {
  const royale = isBattleRoyale(settings.maxPlayers);
  const rules: [string, string][] = [
    ['🎯', `You each get a secret ${settings.wordLength}-letter word. Green = right spot, orange = wrong spot, blue-grey = not in the word.`],
    royale
      ? ['👀', 'Battle royale: you’re paired with ONE random opponent — you fight only them, they fight only you, and you watch each other’s board live. With an odd number of players, one waits for the next free opponent.']
      : ['👀', 'You can see your opponent’s board live — and they can see yours.'],
    royale
      ? ['⚔️', `STEAL your opponent’s word to knock them out — then you’re paired with another free player. A steal costs one of your ${settings.baseRows} rows.`]
      : ['⚔️', `Tap their board to STEAL: guess THEIR word to knock them out. A steal costs one of your ${settings.baseRows} rows.`],
    [
      '🛡️',
      `Solve your own word to become shielded + get ${settings.postSolveStealRows} free steal shots. ${royale ? 'Last one standing — or the best (fewest-row) solve — wins.' : 'Fewer rows wins.'}`,
    ],
    [
      '⏱️',
      `${duration(settings.matchMs)}. Nobody solved? Overtime: +${settings.overtimeExtraRows} rows, ${duration(settings.overtimeMs)}. Still nothing — everybody loses.`,
    ],
  ];
  return (
    <ul className={`space-y-2 text-left ${compact ? 'text-sm' : 'text-sm sm:text-base'}`}>
      {rules.map(([icon, text]) => (
        <li key={icon} className="flex gap-3">
          <span aria-hidden className="shrink-0">
            {icon}
          </span>
          <span className="text-muted">{text}</span>
        </li>
      ))}
    </ul>
  );
}
