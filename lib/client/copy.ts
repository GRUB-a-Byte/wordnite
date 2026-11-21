import { isBattleRoyale } from '@/lib/engine/state';
import type { GameResult, OutcomeReason, PublicPlayer, RejectReason } from '@/lib/engine/types';
import { findPlayer, nicknameOf } from './players';

/** User-facing text for rejections (FR-3.3, E-2, E-6, E-12). */
export const REJECT_TEXT: Record<RejectReason, string> = {
  invalid_word: 'Not in word list',
  duplicate: 'Already tried',
  duplicate_seq: 'Already sent',
  target_shielded: 'Shielded! They already solved their word',
  target_eliminated: 'Target already eliminated',
  invalid_target: 'You can’t attack that board',
  no_ammo: 'Out of ammo',
  no_rows: 'No rows left',
  not_playing: 'Too late — the round is over',
  eliminated: 'You’re eliminated',
  already_solved: 'You already solved — attack instead!',
  not_host: 'Only the host can do that',
  not_a_player: 'You’re spectating',
  not_enough_players: 'Need 2 connected players',
  invalid_settings: 'Invalid settings',
};

/** FR-6.1 outcome reasons (short headline form). */
export const REASON_TEXT: Record<OutcomeReason, string> = {
  stolen: 'Word stolen',
  fewer_rows: 'Solved in fewer rows',
  same_rows_earlier: 'Solved first on the same row count',
  opponent_out_of_rows: 'Out of rows',
  unbeatable: 'Opponent can’t catch up',
  timeout_solver: 'Time — solver wins',
  forfeit: 'Opponent forfeited',
  overtime_expired: 'Overtime expired — everybody loses',
  all_eliminated: 'Everybody was eliminated',
  abandoned: 'Host left — game abandoned',
};

export type Perspective = 'win' | 'lose' | 'draw' | 'spectator' | 'abandoned';

export function perspectiveOf(result: GameResult | undefined, meId: string, isPlayer: boolean): Perspective {
  if (!result || result.outcome === 'abandoned') return 'abandoned';
  if (result.outcome === 'draw') return 'draw';
  if (!isPlayer) return 'spectator';
  return result.winnerId === meId ? 'win' : 'lose';
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export function placeOf(result: GameResult | undefined, playerId: string): number | undefined {
  return result?.standings?.find((s) => s.playerId === playerId)?.place;
}

/** Headline reason. Battle royales (3+ players) describe the match, not "the opponent". */
export function reasonText(result: GameResult, playerCount: number): string {
  if (!isBattleRoyale(playerCount)) return REASON_TEXT[result.reason];
  switch (result.reason) {
    case 'stolen':
    case 'opponent_out_of_rows':
    case 'forfeit':
      return 'Last one standing';
    case 'fewer_rows':
    case 'same_rows_earlier':
    case 'unbeatable':
    case 'timeout_solver':
      return 'Best solve wins';
    default:
      return REASON_TEXT[result.reason];
  }
}

/** One status word for a player in the final standings / arena lists. */
export function playerFate(p: PublicPlayer, players: readonly PublicPlayer[]): string {
  if (p.status === 'invulnerable' || p.solvedInRows !== undefined) return `🛡 solved in ${p.solvedInRows}`;
  if (p.status === 'alive') return 'survived';
  const by = findPlayer(players, p.eliminatedBy)?.nickname;
  if (p.eliminationReason === 'stolen') return by ? `stolen by ${by}` : 'word stolen';
  if (p.eliminationReason === 'out_of_rows') return 'out of rows';
  return 'left the game';
}

/**
 * One-line explanation of why the match ended, tailored to the viewer. FIX 5: an "unbeatable"
 * finish must never read like an elimination or a steal.
 */
export function explainResult(result: GameResult, players: readonly PublicPlayer[], meId: string): string {
  if (isBattleRoyale(players.length)) return explainRoyale(result, players, meId);
  const name = (id?: string) => nicknameOf(players, id, 'Opponent');
  const winner = findPlayer(players, result.winnerId);
  const loser = findPlayer(players, result.loserId);
  const iWon = result.winnerId === meId;
  const iLost = result.loserId === meId;
  switch (result.reason) {
    case 'stolen':
      return iWon
        ? `You stole ${name(result.loserId)}’s word!`
        : iLost
          ? `${name(result.winnerId)} stole your word.`
          : `${name(result.winnerId)} stole ${name(result.loserId)}’s word.`;
    case 'fewer_rows':
      return `${iWon ? 'You' : name(result.winnerId)} solved in ${winner?.solvedInRows} rows vs ${loser?.solvedInRows}.`;
    case 'same_rows_earlier':
      return `Both solved in ${winner?.solvedInRows} rows — ${iWon ? 'you were' : `${name(result.winnerId)} was`} faster.`;
    case 'opponent_out_of_rows':
      return iLost ? 'You ran out of rows.' : `${name(result.loserId)} ran out of rows.`;
    case 'unbeatable':
      return iWon
        ? `You solved in ${winner?.solvedInRows} — ${name(result.loserId)} could no longer beat that.`
        : iLost
          ? `${name(result.winnerId)} solved in ${winner?.solvedInRows} rows and you could no longer beat it — not eliminated, just out-scored.`
          : `${name(result.winnerId)} solved in ${winner?.solvedInRows} rows — an unbeatable lead.`;
    case 'timeout_solver':
      return `Time ran out — ${iWon ? 'you were' : `${name(result.winnerId)} was`} the only one who solved.`;
    case 'forfeit':
      return iLost ? 'You disconnected for too long.' : `${name(result.loserId)} disconnected and forfeited.`;
    case 'overtime_expired':
      return 'Overtime ran out with nobody solving. Everybody loses!';
    case 'all_eliminated':
      return 'Nobody is left standing.';
    case 'abandoned':
      return 'The host left, so the match was abandoned.';
  }
}

function explainRoyale(result: GameResult, players: readonly PublicPlayer[], meId: string): string {
  const winner = findPlayer(players, result.winnerId);
  const iWon = result.winnerId === meId;
  const who = iWon ? 'You' : (winner?.nickname ?? 'Someone');
  const total = players.length;
  const myPlace = placeOf(result, meId);
  const mine = myPlace && !iWon ? ` You finished ${ordinal(myPlace)} of ${total}.` : '';
  switch (result.reason) {
    case 'stolen':
    case 'opponent_out_of_rows':
    case 'forfeit':
      return `${who} outlasted all ${total - 1} rivals — last one standing!${mine}`;
    case 'fewer_rows':
    case 'same_rows_earlier':
    case 'unbeatable':
      return `${who} had the best solve: ${winner?.solvedInRows} rows.${mine}`;
    case 'timeout_solver':
      return `Time ran out — ${iWon ? 'your' : `${who}’s`} ${winner?.solvedInRows}-row solve was the best.${mine}`;
    case 'overtime_expired':
      return `Overtime ran out with nobody solving. Everybody loses!`;
    case 'all_eliminated':
      return 'Nobody is left standing.';
    case 'abandoned':
      return 'The host left, so the match was abandoned.';
  }
}
