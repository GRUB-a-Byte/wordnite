import { randomInt } from './rng';

/**
 * GR-2: picks `count` DISTINCT secret words from the answer list.
 * Uses a partial Fisher–Yates over indices so distinctness is guaranteed, not retried.
 */
export function pickSecrets(answers: readonly string[], count: number, rng: () => number): string[] {
  const unique = Array.from(new Set(answers));
  if (unique.length < count) {
    throw new Error(`pickSecrets: need ${count} distinct answers, only ${unique.length} available`);
  }
  const idx = unique.map((_, i) => i);
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const j = i + randomInt(rng, idx.length - i);
    [idx[i], idx[j]] = [idx[j] as number, idx[i] as number];
    picked.push(unique[idx[i] as number] as string);
  }
  return picked;
}
