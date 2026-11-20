/** Small deterministic PRNG (mulberry32) so tests and `?seed=` runs are reproducible (NFR-8). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, n). */
export function randomInt(rng: () => number, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}
