import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { describe, expect, it } from 'vitest';
import { base64Cores, formsFor } from '../../src/canary/forms.js';
import { generateCanary } from '../../src/canary/generate.js';
import { scanSurface, type Surface } from '../../src/canary/matcher.js';
import type { Canary } from '../../src/types.js';
import { pick, seededRng } from '../../src/util/random.js';

const hash = (alg: string, s: string): string => createHash(alg).update(s).digest('hex');
const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');
const url = (query: string): Surface => ({ surface: 'url', text: `https://tracker.example/collect?${query}` });
const body = (text: string): Surface => ({ surface: 'body', text });

function canaries(seed: string): { search: Canary; email: Canary; phone: Canary } {
  const rng = seededRng(seed);
  const opts = { rng, allowGeneratedPhone: true };
  return {
    search: generateCanary('search', { type: 'search-term', base: 'metformin 500' }, opts),
    email: generateCanary('email', { type: 'email' }, opts),
    phone: generateCanary('phone', { type: 'phone' }, opts),
  };
}

/**
 * CleverTap's web SDK (3.0 and later) can encrypt the event payload "in transit": AES-GCM with a
 * random key, and the key itself travels base64-encoded in the same envelope (itp, itk, itv).
 */
function cleverTapEnvelope(plain: string): Record<string, unknown> {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { itp: sealed.toString('base64'), itk: key.toString('base64'), itv: iv.toString('base64'), id: 'TEST-000-000Z', encrypted: true };
}

/** Every way we expect a tracker might wrap a value. Each returns the surface that would be on the wire. */
const TEXT_WRAPPERS: Record<string, (v: string) => Surface> = {
  'bare URL parameter': (v) => url(`q=${encodeURIComponent(v)}`),
  'plus-encoded URL parameter': (v) => url(`q=${v.replace(/ /g, '+')}`),
  'nested Meta-style parameter': (v) => url(`id=1&ev=Search&cd%5Bsearch_string%5D=${encodeURIComponent(v)}`),
  'double URL encoding': (v) => url(`data=${encodeURIComponent(`event=search;search_term=${encodeURIComponent(v)}`)}`),
  'triple URL encoding': (v) => url(`u=${encodeURIComponent(encodeURIComponent(encodeURIComponent(v)))}`),
  'upper case': (v) => url(`q=${encodeURIComponent(v.toUpperCase())}`),
  'mixed case, double encoded': (v) =>
    url(`q=${encodeURIComponent(encodeURIComponent([...v].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('')))}`),
  'page URL inside a parameter': (v) =>
    url(`dl=${encodeURIComponent(`https://shop.example/search?q=${encodeURIComponent(v)}`)}`),
  'hyphenated path slug': (v) => ({ surface: 'url', text: `https://t.example/s/${v.replace(/\s+/g, '-')}/p.gif` }),
  'referer header': (v) => ({
    surface: 'header',
    surfaceName: 'referer',
    text: `https://shop.example/search?q=${encodeURIComponent(v)}`,
  }),
  'form body': (v) => body(`en=view_search_results&ep.search_term=${encodeURIComponent(v)}`),
  'multi-line GA4 batch body': (v) => body(`en=page_view&_et=1\nen=view_search_results&ep.search_term=${encodeURIComponent(v)}`),
  'JSON body': (v) => body(JSON.stringify({ events: [{ name: 'search', props: { term: v } }] })),
  'base64 of the value alone': (v) => url(`x=${encodeURIComponent(b64(v))}`),
  'base64url of JSON in a URL': (v) =>
    url(`d=${b64(JSON.stringify({ evtName: 'Searched', evtData: { term: v } })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`),
  'base64 JSON inside JSON': (v) => body(JSON.stringify({ d: b64(JSON.stringify({ evtData: { q: v } })) })),
  'base64 with a raw + in the query': (v) => url(`d=${b64(JSON.stringify({ pad: '>>>???', q: v }))}`),
  'base64 buried in other text': (v) => body(`blob:${b64(`xx${v}yy`)}:end`),
  'gzip then base64': (v) => body(JSON.stringify({ payload: b64(gzipSync(JSON.stringify({ search: v }))) })),
  'LZ-string (CleverTap style)': (v) =>
    url(`t=96&d=${encodeURIComponent(LZString.compressToBase64(JSON.stringify({ type: 'event', evtName: 'Searched', evtData: { Term: v } })))}`),
  'CleverTap encryption in transit (key sent alongside)': (v) =>
    url(`t=96&d=${encodeURIComponent(LZString.compressToBase64(JSON.stringify(cleverTapEnvelope(LZString.compressToBase64(JSON.stringify([{ type: 'event', evtName: 'Searched', evtData: { Term: v } }]))))))}`),
  'SHA-256 of lower-cased value': (v) => url(`h=${hash('sha256', v.trim().toLowerCase())}`),
  'SHA-256, upper-case hex': (v) => url(`h=${hash('sha256', v.trim().toLowerCase()).toUpperCase()}`),
  'MD5 of the value as typed': (v) => body(JSON.stringify({ id: hash('md5', v) })),
  'SHA-1 of lower-cased value': (v) => body(`uid=${hash('sha1', v.trim().toLowerCase())}`),
  'SHA-256 in base64': (v) => url(`h=${encodeURIComponent(createHash('sha256').update(v.trim().toLowerCase()).digest('base64'))}`),
};

const PHONE_WRAPPERS: Record<string, (n: string) => Surface> = {
  'bare digits': (n) => url(`ph=${n}`),
  'with +91': (n) => url(`ph=${encodeURIComponent(`+91${n}`)}`),
  'grouped 5-5': (n) => body(JSON.stringify({ phone: `${n.slice(0, 5)} ${n.slice(5)}` })),
  'as a JSON number with country code': (n) => body(`{"phone":91${n}}`),
  'Meta advanced matching (SHA-256 of 91 + number)': (n) => url(`ud%5Bph%5D=${hash('sha256', `91${n}`)}`),
  'Google enhanced conversions (SHA-256 of +91 + number)': (n) => url(`em=tv.1~pn.${hash('sha256', `+91${n}`)}`),
  'SHA-256 of bare number': (n) => url(`p=${hash('sha256', n)}`),
  'MD5 of 0 + number': (n) => url(`p=${hash('md5', `0${n}`)}`),
};

describe('canary generator', () => {
  it('makes values that are unique per seed and stable for the same seed', () => {
    const a = canaries('seed-a');
    const b = canaries('seed-b');
    expect(canaries('seed-a')).toEqual(a);
    expect(a.search.value).not.toEqual(b.search.value);
    expect(a.search.value).toMatch(/^metformin 500 [bcdfghjkmnpqrstvwxz]{7}$/);
    expect(a.email.value).toMatch(/^khara\.[a-z]{7}@example\.com$/);
    expect(a.phone.value).toMatch(/^[6-9]\d{9}$/);
  });

  it('refuses to invent a phone number for a live site', () => {
    expect(() =>
      generateCanary('phone', { type: 'phone' }, { rng: seededRng('x'), allowGeneratedPhone: false }),
    ).toThrow(/real person/);
  });

  it('reads supplied values from the environment and refuses very short ones', () => {
    const opts = { rng: seededRng('x'), allowGeneratedPhone: false, env: { MY_PHONE: '0000012345' } };
    expect(generateCanary('phone', { type: 'phone', valueFromEnv: 'MY_PHONE' }, opts).value).toBe('0000012345');
    expect(() => generateCanary('t', { type: 'text', value: 'ab' }, opts)).toThrow(/"ab" \(the typed text\) is too short/);
    expect(generateCanary('t', { type: 'search-term', value: 'HIV' }, opts).unique).toBe(false);
    expect(() => generateCanary('t', { type: 'email', value: 'a@b.c' }, opts)).toThrow(/too short/);
    expect(() => generateCanary('p', { type: 'phone', valueFromEnv: 'NOPE' }, opts)).toThrow(/not set/);
  });
});

describe('base64 alignment cores', () => {
  it('are found inside base64 of any surrounding text', () => {
    const rng = seededRng('cores');
    for (let i = 0; i < 300; i++) {
      const value = pick(rng, 'abcdefghijklmnopqrstuvwxyz0123456789 @.', 6 + rng.int(30));
      const prefix = pick(rng, 'abcdefghij{}":,', rng.int(12));
      const suffix = pick(rng, 'abcdefghij{}":,', rng.int(12));
      const blob = b64(prefix + value + suffix);
      const cores = base64Cores(value);
      expect(cores.some((core) => blob.includes(core))).toBe(true);
    }
  });
});

describe('matcher: every disguise of every canary is found', () => {
  for (let i = 0; i < 25; i++) {
    const c = canaries(`property-${i}`);
    const forms = [...formsFor(c.search), ...formsFor(c.email), ...formsFor(c.phone)];

    it(`seed ${i}: search term and email in ${Object.keys(TEXT_WRAPPERS).length} wrappers`, () => {
      for (const canary of [c.search, c.email]) {
        for (const [name, wrap] of Object.entries(TEXT_WRAPPERS)) {
          const sightings = scanSurface(wrap(canary.value), forms).filter((s) => s.canary === canary.name);
          expect(sightings.length, `${canary.name} via ${name}`).toBeGreaterThan(0);
          expect(sightings.every((s) => s.exactness === 'full'), `${canary.name} via ${name} is a full match`).toBe(true);
        }
      }
    });

    it(`seed ${i}: phone in ${Object.keys(PHONE_WRAPPERS).length} wrappers`, () => {
      for (const [name, wrap] of Object.entries(PHONE_WRAPPERS)) {
        const sightings = scanSurface(wrap(c.phone.value), forms).filter((s) => s.canary === 'phone');
        expect(sightings.length, `phone via ${name}`).toBeGreaterThan(0);
      }
    });
  }
});

describe('matcher: says where and how', () => {
  const c = canaries('where');
  const forms = [...formsFor(c.search), ...formsFor(c.email), ...formsFor(c.phone)];

  it('names the exact URL parameter and reports readable text', () => {
    const [s] = scanSurface(TEXT_WRAPPERS['nested Meta-style parameter']!(c.search.value), forms);
    expect(s).toMatchObject({ field: 'cd[search_string]', formKind: 'plain', surface: 'url' });
    expect(s!.rawOffset).toBeUndefined(); // percent-encoded on the wire, so not literally present
  });

  it('reports each field separately when the value appears twice in one request', () => {
    const q = encodeURIComponent(c.search.value);
    const sightings = scanSurface(url(`cd%5Bsearch_string%5D=${q}&dl=${encodeURIComponent(`https://s.example/?q=${q}`)}`), forms);
    expect(sightings.map((s) => s.field).sort()).toEqual(['cd[search_string]', 'dl › q']);
  });

  it('follows base64 inside JSON and labels it as encoded, with the inner field path', () => {
    const [s] = scanSurface(TEXT_WRAPPERS['base64 JSON inside JSON']!(c.search.value), forms);
    expect(s).toMatchObject({ field: 'd › evtData.q', formKind: 'encoded' });
    expect(s!.chain).toEqual(['JSON field "d"', 'base64-decoded', 'JSON field "evtData.q"']);
  });

  it('labels hashes as hashes and says which normalisation was used', () => {
    const [s] = scanSurface(url(`ud%5Bem%5D=${hash('sha256', c.email.value.toLowerCase())}`), forms);
    expect(s).toMatchObject({ field: 'ud[em]', formKind: 'hash', canary: 'email' });
    expect(s!.formLabel).toMatch(/SHA-256/);
    expect(s!.rawOffset).toBeGreaterThan(0);
  });

  it('reports a marker-only match as partial', () => {
    const [s] = scanSurface(url(`kw=${c.search.marker}`), forms);
    expect(s).toMatchObject({ exactness: 'marker', canary: 'search' });
  });
});

describe('matcher: no false positives', () => {
  it('finds nothing in requests that carry other values', () => {
    const rng = seededRng('noise');
    const c = canaries('quiet');
    const forms = [...formsFor(c.search), ...formsFor(c.email), ...formsFor(c.phone)];
    const other = canaries('someone-else');
    for (let i = 0; i < 400; i++) {
      const noise = pick(rng, 'abcdefghijklmnopqrstuvwxyz0123456789-_ %', 5 + rng.int(120));
      const digits = pick(rng, '0123456789', 6 + rng.int(20));
      const surfaces: Surface[] = [
        url(`q=${encodeURIComponent(noise)}&t=${digits}&h=${hash('sha256', noise)}`),
        body(JSON.stringify({ a: noise, b: b64(noise), c: Number(digits.slice(0, 12)), d: hash('md5', digits) })),
        body(b64(gzipSync(noise))),
        // The same journey run by someone else: same base term, different marker.
        ...Object.values(TEXT_WRAPPERS).map((wrap) => wrap(other.search.value)),
        ...Object.values(TEXT_WRAPPERS).map((wrap) => wrap(other.email.value)),
        ...Object.values(PHONE_WRAPPERS).map((wrap) => wrap(other.phone.value)),
        url('q=metformin+500'),
        url(`q=${encodeURIComponent('metformin 500 mg tablets')}`),
      ];
      for (const surface of i === 0 ? surfaces : surfaces.slice(0, 3)) {
        expect(scanSurface(surface, forms), surface.text.slice(0, 120)).toEqual([]);
      }
    }
  });
});
