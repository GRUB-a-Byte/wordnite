import { DEFAULT_SETTINGS } from '@/lib/engine/settings';
import type { GameSettings } from '@/lib/engine/types';

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`;
}

/** FR-2.5 / NFR-10: the whole ruleset in ≤ 6 bullets (numbers come from GameSettings, NFR-12). */
export function HowToPlay({ compact = false, settings = DEFAULT_SETTINGS }: { compact?: boolean; settings?: GameSettings }) {
  const rules: [string, string][] = [
    ['🎯', `You each get a secret ${settings.wordLength}-letter word. Teal = right spot, amber = wrong spot, slate = not in the word.`],
    ['👀', 'You can see your opponent’s board live — and they can see yours.'],
    ['⚔️', `Tap their board to STEAL: guess THEIR word to knock them out. A steal costs one of your ${settings.baseRows} rows.`],
    ['🛡️', `Solve your own word to become shielded + get ${settings.postSolveStealRows} free steal shots. Fewer rows wins.`],
    [
      '⏱️',
      `${duration(settings.matchMs)}. Nobody solved? Overtime: +${settings.overtimeExtraRows} rows, ${duration(settings.overtimeMs)}. Still nothing — everybody loses.`,
    ],
  ];
  // FR-2.5 (amended): the sixth bullet only appears once the room is a king-of-the-hill session.
  if (settings.maxPlayers > 2) {
    rules.push(['👑', 'Win your duel to stay on the hill — lose and you’re out. Last one standing is champion.']);
  }
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
