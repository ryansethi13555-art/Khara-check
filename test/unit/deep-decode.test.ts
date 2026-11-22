import { createHash } from 'node:crypto';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { describe, expect, it } from 'vitest';
import { formsFor } from '../../src/canary/forms.js';
import { generateCanary } from '../../src/canary/generate.js';
import { scanSurface } from '../../src/canary/matcher.js';
import { parseMessage } from '../../src/canary/protobuf.js';
import { pick, seededRng, type Rng } from '../../src/util/random.js';

// ---- a tiny protobuf writer, for building test messages ---------------------------------------
function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
function pbField(field: number, value: Buffer | string | number): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint(field << 3), varint(value)]);
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64');
const b64url = (b: Buffer | string): string => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Every layer a tracker might wrap a value in. Each takes the text so far and returns new text.
 * Binary layers (compression, protobuf) are always followed by base64, as they would be in a
 * text protocol.
 */
const LAYERS: Record<string, (inner: string, rng: Rng) => string> = {
  'URL parameter': (s, rng) => `a=${rng.int(99)}&${pick(rng, 'xyz', 3)}=${encodeURIComponent(s)}&z=1`,
  'full URL': (s) => `https://collect.example/e?d=${encodeURIComponent(s)}`,
  'JSON field': (s, rng) => JSON.stringify({ v: 2, [pick(rng, 'abcdef', 4)]: s, n: [1, 2] }),
  'JSON array': (s) => JSON.stringify([{ e: 'x' }, { payload: s }]),
  base64: (s) => b64(s),
  base64url: (s) => b64url(s),
  'gzip + base64': (s) => b64(gzipSync(s)),
  'zlib deflate + base64': (s) => b64(deflateSync(s)),
  'raw deflate + base64': (s) => b64(deflateRawSync(s)),
  'brotli + base64': (s) => b64(brotliCompressSync(Buffer.from(s))),
  'LZ-string': (s) => LZString.compressToBase64(s),
  'LZ-string (URI)': (s) => LZString.compressToEncodedURIComponent(s),
  JWT: (s) =>
    `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub: 'x', data: s }))}.${b64url('signature-bytes')}`,
  // Each multipart layer gets its own boundary, as a real encoder would choose.
  multipart: (s, rng) => {
    const b = `----khara${pick(rng, 'abcdefghijklmnop0123456789', 12)}`;
    return [`--${b}`, 'Content-Disposition: form-data; name="meta"', '', 'v1', `--${b}`, 'Content-Disposition: form-data; name="event"', '', s, `--${b}--`, ''].join('\r\n');
  },
  'protobuf + base64': (s, rng) => b64(Buffer.concat([pbField(1, rng.int(500)), pbField(2, Buffer.concat([pbField(1, 'ev'), pbField(4, s)]))])),
  'form body': (s) => `en=search&ep.q=${encodeURIComponent(s)}`,
};
const LAYER_NAMES = Object.keys(LAYERS);

function wrapRandomly(value: string, rng: Rng, depth: number): { text: string; stack: string[] } {
  let text = value;
  const stack: string[] = [];
  for (let i = 0; i < depth; i++) {
    const name = LAYER_NAMES[rng.int(LAYER_NAMES.length)]!;
    text = LAYERS[name]!(text, rng);
    stack.push(name);
  }
  return { text, stack };
}

describe('deep decoding: random stacks of encodings', () => {
  const rng = seededRng('deep');
  const opts = { rng, allowGeneratedPhone: true };
  const search = generateCanary('search', { type: 'search-term', base: 'metformin 500' }, opts);
  const email = generateCanary('email', { type: 'email' }, opts);
  const forms = [...formsFor(search), ...formsFor(email)];

  it('finds the value under every single layer', () => {
    for (const [name, layer] of Object.entries(LAYERS)) {
      for (const canary of [search, email]) {
        const hits = scanSurface({ surface: 'body', text: layer(canary.value, rng) }, forms).filter((s) => s.canary === canary.name);
        expect(hits.length, `${canary.name} under ${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('finds the value under 600 random stacks up to 5 layers deep, and records the path', () => {
    let deepest = 0;
    for (let i = 0; i < 600; i++) {
      const depth = 1 + (i % 5);
      const canary = i % 2 ? search : email;
      const { text, stack } = wrapRandomly(canary.value, rng, depth);
      const hits = scanSurface({ surface: 'body', text }, forms).filter((s) => s.canary === canary.name);
      expect(hits.length, `${canary.name} under ${stack.join(' > ')}`).toBeGreaterThan(0);
      expect(hits[0]!.exactness, stack.join(' > ')).toBe('full');
      deepest = Math.max(deepest, hits[0]!.chain.length);
    }
    expect(deepest).toBeGreaterThanOrEqual(5);
  });

  it('finds a hashed email under random stacks too', () => {
    const hashed = createHash('sha256').update(email.value.toLowerCase()).digest('hex');
    for (let i = 0; i < 200; i++) {
      const { text, stack } = wrapRandomly(hashed, rng, 1 + (i % 5));
      const hits = scanSurface({ surface: 'body', text }, forms).filter((s) => s.canary === 'email');
      expect(hits.length, stack.join(' > ')).toBeGreaterThan(0);
      expect(hits[0]!.formKind).toBe('hash');
    }
  });

  it('never finds the value in random noise wrapped the same ways', () => {
    for (let i = 0; i < 600; i++) {
      const noise = pick(rng, 'abcdefghijklmnopqrstuvwxyz0123456789 .@-', 6 + rng.int(60));
      const { text, stack } = wrapRandomly(noise, rng, 1 + (i % 5));
      expect(scanSurface({ surface: 'body', text }, forms), stack.join(' > ')).toEqual([]);
      // The same base term from someone else's run (different marker) must not match either.
      const other = `metformin 500 ${pick(rng, 'bcdfghjkmnpqrstvwxz', 7)}`;
      expect(scanSurface({ surface: 'body', text: wrapRandomly(other, rng, 1 + (i % 5)).text }, forms)).toEqual([]);
    }
  });

  it('reports a readable path through the layers', () => {
    const text = LAYERS['JSON field']!(LAYERS['protobuf + base64']!(LAYERS['gzip + base64']!(search.value, rng), rng), rng);
    const [hit] = scanSurface({ surface: 'body', text }, forms);
    expect(hit!.chain.join(' → ')).toMatch(/JSON field ".+" → base64-decoded, then read as protobuf \(no schema\) → JSON field "2\.4" → base64-decoded, then decompressed \(gzip\)/);
  });
});

describe('schema-less protobuf reader', () => {
  it('reads nested messages, strings, numbers and repeated fields', () => {
    const msg = Buffer.concat([pbField(1, 150), pbField(2, 'hello world'), pbField(3, Buffer.concat([pbField(1, 'inner text'), pbField(2, 7)])), pbField(2, 'again')]);
    expect(parseMessage(msg)).toEqual({ '1': 150, '2': ['hello world', 'again'], '3': { '1': 'inner text', '2': 7 } });
  });

  it('turns raw hash bytes into hex so hashed values are still found', () => {
    const raw = createHash('sha256').update('x@example.com').digest();
    expect(parseMessage(pbField(5, raw))).toEqual({ '5': raw.toString('hex') });
  });

  it('rejects text and truncated messages', () => {
    expect(parseMessage(Buffer.from('just some text, not protobuf'))).toBeNull();
    expect(parseMessage(pbField(2, 'hello world').subarray(0, 6))).toBeNull();
  });
});
