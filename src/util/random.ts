import { randomBytes } from 'node:crypto';
import { digest } from './hash.js';

/** A source of random integers. Seeded for tests and reproducible demos, cryptographic otherwise. */
export interface Rng {
  /** Uniform integer in [0, n). */
  int(n: number): number;
}

export function cryptoRng(): Rng {
  return {
    int(n: number): number {
      // Rejection sampling keeps the distribution uniform.
      const limit = Math.floor(0x1_0000_0000 / n) * n;
      for (;;) {
        const x = randomBytes(4).readUInt32BE(0);
        if (x < limit) return x % n;
      }
    },
  };
}

/** Deterministic generator: SHA-256 in counter mode over the seed. */
export function seededRng(seed: string): Rng {
  let counter = 0;
  let pool = Buffer.alloc(0);
  const next32 = (): number => {
    if (pool.length < 4) {
      pool = Buffer.concat([pool, digest('sha256', `${seed}:${counter++}`)]);
    }
    const x = pool.readUInt32BE(0);
    pool = pool.subarray(4);
    return x;
  };
  return {
    int(n: number): number {
      const limit = Math.floor(0x1_0000_0000 / n) * n;
      for (;;) {
        const x = next32();
        if (x < limit) return x % n;
      }
    },
  };
}

export function pick(rng: Rng, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[rng.int(alphabet.length)];
  return out;
}
