import { createHash } from 'node:crypto';

export type HashAlgorithm = 'sha256' | 'sha1' | 'md5';

export function digest(algorithm: HashAlgorithm, data: string | Uint8Array): Buffer {
  return createHash(algorithm).update(data).digest();
}

export function sha256Hex(data: string | Uint8Array): string {
  return digest('sha256', data).toString('hex');
}

/**
 * JSON with keys in sorted order and no insignificant whitespace.
 * Two machines given the same data produce the same bytes, which is what makes hashes comparable.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function prettyCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
