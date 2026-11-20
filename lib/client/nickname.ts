/**
 * NFR-16: nicknames are rendered as plain text (React escaping), capped at 16 characters, and run
 * through a small profanity mask for projector safety.
 */
const BLOCKED_ROOTS = [
  'fuck', 'shit', 'cunt', 'nigg', 'fag', 'bitch', 'whore', 'slut', 'dick', 'cock', 'pussy',
  'rape', 'nazi', 'penis', 'twat', 'wank', 'porn', 'bastard', 'asshole', 'retard', 'kike', 'spic',
  'chink', 'dyke', 'tranny', 'hitler', 'jizz', 'tits', 'boob',
];

export const NICKNAME_MAX = 16;

export function sanitizeNickname(raw: string): string {
  let nick = raw.replace(/\s+/g, ' ').trim().slice(0, NICKNAME_MAX);
  // Compare on a lower-cased, leetspeak-folded copy (same length), then mask the same span.
  const folded = nick
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's');
  for (const root of BLOCKED_ROOTS) {
    let idx = folded.indexOf(root);
    while (idx >= 0) {
      nick = nick.slice(0, idx) + '*'.repeat(root.length) + nick.slice(idx + root.length);
      idx = folded.indexOf(root, idx + root.length);
    }
  }
  return nick;
}
