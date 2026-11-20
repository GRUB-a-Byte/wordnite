import type { WordDictionary } from '@/lib/engine/types';

/** Splits a packed string of consecutive fixed-length words. */
export function unpackWords(packed: string, length = 5): string[] {
  const out: string[] = [];
  for (let i = 0; i + length <= packed.length; i += length) out.push(packed.slice(i, i + length));
  return out;
}

export function createDictionary(validWords: Iterable<string>, answers: readonly string[]): WordDictionary {
  const set = new Set<string>(validWords);
  for (const a of answers) set.add(a);
  return {
    isValid: (word: string) => set.has(word.toUpperCase()),
    answers,
  };
}

let cached: Promise<WordDictionary> | null = null;

/**
 * Lazily loads both lists (SRS §8.7: the ~11k valid list is code-split and fetched while the lobby
 * is on screen, keeping the initial room bundle small — NFR-4).
 */
export function loadDictionary(): Promise<WordDictionary> {
  if (!cached) {
    cached = Promise.all([import('./valid'), import('./answers')])
      .then(([v, a]) => createDictionary(unpackWords(v.PACKED_VALID), unpackWords(a.PACKED_ANSWERS)))
      .catch((err: unknown) => {
        cached = null; // allow a retry after a network hiccup
        throw err;
      });
  }
  return cached;
}
