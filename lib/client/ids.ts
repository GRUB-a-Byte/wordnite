/** FR-1.2: unambiguous room-code alphabet — no I, O (and no digits, so no 0 / 1). */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

function randomValues(n: number): Uint32Array {
  // crypto.getRandomValues works in insecure contexts too (e.g. http://192.168.x.x on a LAN),
  // unlike crypto.randomUUID.
  const buf = new Uint32Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export function generateRoomCode(): string {
  return Array.from(randomValues(4), (v) => ROOM_ALPHABET[v % ROOM_ALPHABET.length]).join('');
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_RE.test(code);
}

/** Lower-case base36 id (never collides with upper-case secret words in leak checks). */
export function generatePlayerId(): string {
  return Array.from(randomValues(3), (v) => v.toString(36).padStart(7, '0'))
    .join('')
    .slice(0, 18);
}

export function randomSeed(): number {
  return randomValues(1)[0] as number;
}
