import { createDecipheriv } from 'node:crypto';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { protobufToJson } from './protobuf.js';
import LZString from 'lz-string';

/**
 * Trackers rarely send a value bare. It sits inside a URL parameter, inside JSON, inside
 * base64, sometimes all three. `unfold` peels those layers one at a time and returns every
 * layer as a node in a tree, so the matcher can say exactly which field carried the value
 * and how it was wrapped.
 */
export interface LayerNode {
  id: number;
  parent: number;
  text: string;
  /** How this layer was obtained from its parent, in plain words. Empty for the root. */
  step: string;
  /** Field name contributed by this layer, e.g. `cd[search_string]` or `evtData.term`. */
  field?: string;
  /** Set when this layer was hidden behind an encoding that is not ordinary transport encoding. */
  obfuscation?: 'base64' | 'lz-string' | 'gzip' | 'jwt' | 'protobuf' | 'aes-gcm';
  depth: number;
}

interface Edge {
  text: string;
  step: string;
  field?: string;
  obfuscation?: LayerNode['obfuscation'];
}

export interface UnfoldLimits {
  maxDepth: number;
  maxNodes: number;
  maxTextLength: number;
}

export const DEFAULT_LIMITS: UnfoldLimits = { maxDepth: 8, maxNodes: 4000, maxTextLength: 4_000_000 };

export function unfold(rootText: string, limits: UnfoldLimits = DEFAULT_LIMITS): LayerNode[] {
  const nodes: LayerNode[] = [{ id: 0, parent: -1, text: rootText, step: '', depth: 0 }];
  for (let i = 0; i < nodes.length && nodes.length < limits.maxNodes; i++) {
    const node = nodes[i]!;
    if (node.depth >= limits.maxDepth || node.text.length > limits.maxTextLength) continue;
    for (const edge of childrenOf(node.text)) {
      if (nodes.length >= limits.maxNodes) break;
      if (!edge.text || edge.text === node.text) continue;
      nodes.push({
        id: nodes.length,
        parent: node.id,
        text: edge.text,
        step: edge.step,
        depth: node.depth + 1,
        ...(edge.field !== undefined ? { field: edge.field } : {}),
        ...(edge.obfuscation ? { obfuscation: edge.obfuscation } : {}),
      });
    }
  }
  return nodes;
}

/** Decoding steps from the root down to `node`. */
export function chainOf(nodes: LayerNode[], node: LayerNode): LayerNode[] {
  const chain: LayerNode[] = [];
  for (let n: LayerNode | undefined = node; n && n.parent !== -1; n = nodes[n.parent]) chain.unshift(n);
  return chain;
}

// ---------------------------------------------------------------------------------------------

/** Exactly one structural reading per layer, so sibling layers never overlap. */
function childrenOf(text: string): Edge[] {
  return (
    asUrl(text) ??
    asMultipart(text) ??
    asJson(text) ??
    asJwt(text) ??
    asBase64(text) ??
    asLines(text) ??
    asPairs(text) ??
    asPercentEncoded(text) ??
    []
  );
}

const KEY = /^[A-Za-z0-9_.\-\[\]%$:~!*'()@/ ]{1,200}$/;

function asUrl(text: string): Edge[] | null {
  const m = /^(?:(?:https?|wss?):)?\/\/[^/?#\s]+/i.exec(text);
  if (!m || /\s/.test(text.trim())) return null;
  const rest = text.slice(m[0].length);
  const hashAt = rest.indexOf('#');
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : rest.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);

  const edges: Edge[] = [];
  if (path.length > 1) edges.push({ text: path, step: 'URL path', field: '(path)' });
  for (const [key, value] of splitPairs(query, '&')) {
    if (value) edges.push({ text: value, step: `URL parameter "${key}"`, field: key });
  }
  if (fragment) edges.push({ text: fragment, step: 'URL fragment', field: '(fragment)' });
  return edges;
}

function asJson(text: string): Edge[] | null {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  const edges: Edge[] = [];
  const walk = (value: unknown, path: string): void => {
    if (edges.length >= 2000) return;
    if (typeof value === 'string') {
      if (value.length >= 4) edges.push({ text: value, step: `JSON field "${path}"`, field: path });
    } else if (typeof value === 'number') {
      const s = String(value);
      if (s.length >= 6) edges.push({ text: s, step: `JSON field "${path}"`, field: path });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(parsed, '');
  const opened = openKeyedEnvelope(parsed);
  if (opened !== null) {
    edges.unshift({
      text: opened,
      step: 'encrypted payload opened with the key sent beside it',
      field: '(decrypted)',
      obfuscation: 'aes-gcm',
    });
  }
  return edges;
}

/**
 * CleverTap's web SDK (3.0 and later) has an "encryption in transit" option. It encrypts the
 * payload with AES-GCM under a fresh random key, then sends the key (itk) and nonce (itv) in the
 * same envelope as the ciphertext (itp). Anyone holding the request can open it, so it hides
 * nothing from the receiver; it only hides the contents from a reader who does not know the shape.
 */
function openKeyedEnvelope(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { itp, itk, itv } = value as Record<string, unknown>;
  if (typeof itp !== 'string' || typeof itk !== 'string' || typeof itv !== 'string') return null;
  try {
    const key = Buffer.from(itk, 'base64');
    const iv = Buffer.from(itv, 'base64');
    const sealed = Buffer.from(itp, 'base64');
    if (![16, 24, 32].includes(key.length) || iv.length < 8 || sealed.length <= 16) return null;
    const decipher = createDecipheriv(`aes-${key.length * 8}-gcm` as 'aes-256-gcm', key, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf8');
    return isCleanText(plain) ? plain : null;
  } catch {
    return null;
  }
}

function asBase64(text: string): Edge[] | null {
  // A "+" in a URL parameter arrives as a space; put it back before testing.
  const t = text.trim().replace(/ /g, '+');
  if (t.length < 16) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,3}$/.test(t)) {
    // LZ-string's URL-safe alphabet adds "$", which base64 never uses.
    if (!/^[A-Za-z0-9+$-]+$/.test(t)) return null;
    let out: string | null = null;
    try {
      out = LZString.decompressFromEncodedURIComponent(t);
    } catch {
      out = null;
    }
    return out && out.length >= 4 && isCleanText(out)
      ? [{ text: out, step: 'LZ-string decompressed', obfuscation: 'lz-string' }]
      : null;
  }
  const edges: Edge[] = [];

  const bytes = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const decoded = decodeBytes(bytes);
  if (decoded) {
    edges.push({
      text: decoded.text,
      step: decoded.gunzipped ? `base64-decoded, then ${decoded.how}` : 'base64-decoded',
      obfuscation: 'base64',
    });
  } else {
    const proto = protobufToJson(bytes);
    if (proto) edges.push({ text: proto, step: 'base64-decoded, then read as protobuf (no schema)', obfuscation: 'protobuf' });
    else if (/[\x20-\x7e]{6,}/.test(bytes.toString('latin1'))) {
      // Unknown binary that still holds readable runs: keep it, byte for byte.
      edges.push({ text: bytes.toString('latin1'), step: 'base64-decoded (binary data)', obfuscation: 'base64' });
    }
  }

  // CleverTap and others compress JSON with LZ-string and send the result as base64.
  if (!decoded) {
    // The two LZ-string alphabets differ only in "/" versus "-" (and "=" versus "$"),
    // so the characters present say which one was used.
    const uriFirst = /[-$]/.test(t) && !t.includes('/');
    const order = uriFirst
      ? [LZString.decompressFromEncodedURIComponent, LZString.decompressFromBase64]
      : [LZString.decompressFromBase64, LZString.decompressFromEncodedURIComponent];
    for (const attempt of order) {
      let out: string | null = null;
      try {
        out = attempt(t);
      } catch {
        out = null;
      }
      // When the alphabet is ambiguous both readings can look like text; keep each distinct one.
      if (out && out.length >= 4 && isCleanText(out) && !edges.some((e) => e.text === out)) {
        edges.push({ text: out, step: 'LZ-string decompressed', obfuscation: 'lz-string' });
      }
    }
  }
  return edges.length ? edges : null;
}

/** A JSON Web Token: three base64url parts joined by dots. The first two are JSON. */
function asJwt(text: string): Edge[] | null {
  const t = text.trim();
  const m = /^(?:Bearer\s+)?([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{4,})\.([A-Za-z0-9_-]*)$/.exec(t);
  if (!m) return null;
  const part = (s: string): string | null => {
    const out = decodeBytes(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    return out && /^\s*[[{]/.test(out.text) ? out.text : null;
  };
  const header = part(m[1]!);
  const payload = part(m[2]!);
  if (!header || !payload || !/"(alg|typ)"/.test(header)) return null;
  return [{ text: payload, step: 'JWT payload decoded', field: '(token payload)', obfuscation: 'jwt' }];
}

/** multipart/form-data: "--boundary" lines separating parts, each with its own headers. */
function asMultipart(text: string): Edge[] | null {
  const m = /^--([^\r\n]{1,200})\r?\n/.exec(text);
  if (!m) return null;
  const boundary = `--${m[1]}`;
  const edges: Edge[] = [];
  for (const chunk of text.split(boundary).slice(1)) {
    if (chunk.startsWith('--')) break;
    const split = chunk.search(/\r?\n\r?\n/);
    if (split === -1) continue;
    const head = chunk.slice(0, split);
    const body = chunk.slice(split).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '(part)';
    if (body) edges.push({ text: body, step: `form part "${name}"`, field: name });
  }
  return edges.length ? edges : null;
}

function asLines(text: string): Edge[] | null {
  if (!text.includes('\n')) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2 || lines.length > 500) return null;
  if (!lines.every((l) => /^[^=&\s]+=/.test(l))) return null;
  return lines.map((line, i) => ({ text: line, step: `line ${i + 1}`, field: `line ${i + 1}` }));
}

function asPairs(text: string): Edge[] | null {
  if (!text.includes('=') || text.length > 200_000) return null;
  const separator = text.includes('&') ? '&' : text.includes(';') ? ';' : null;
  const pairs = splitPairs(text, separator ?? '&');
  const withValue = pairs.filter(([, v]) => v !== '');
  if (!pairs.length || !pairs.every(([k]) => KEY.test(k))) {
    // Matrix parameters in a path: /activity;src=1;u1=term
    if (separator !== ';') return null;
    const tail = pairs.filter(([k, v]) => KEY.test(k) && v !== '');
    if (tail.length < 2) return null;
    return tail.map(([k, v]) => ({ text: v, step: `parameter "${k}"`, field: k }));
  }
  if (separator === ';' && withValue.length < 2) return null;
  if (!withValue.length) return null;
  return withValue.map(([k, v]) => ({ text: v, step: `parameter "${k}"`, field: k }));
}

function asPercentEncoded(text: string): Edge[] | null {
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return null;
  const decoded = percentDecode(text);
  return decoded === text ? null : [{ text: decoded, step: 'percent-decoded' }];
}

// ---------------------------------------------------------------------------------------------

/** Splits `a=1&b=2` into decoded [key, value] pairs. Segments without "=" get an empty value. */
function splitPairs(text: string, separator: string): [string, string][] {
  const out: [string, string][] = [];
  for (const segment of text.split(separator)) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    const rawKey = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? '' : segment.slice(eq + 1);
    out.push([formDecode(rawKey).trim(), formDecode(rawValue)]);
  }
  return out;
}

export function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

function formDecode(text: string): string {
  return percentDecode(text.replace(/\+/g, ' '));
}

/** Text with no control characters (other than tab and line breaks), no C1 controls, no lone surrogates. */
export function isCleanText(text: string): boolean {
  return (
    text.length > 0 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/.test(text) &&
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)
  );
}

export function looksPrintable(text: string): boolean {
  if (!text.length) return false;
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && c !== 0xfffd)) printable++;
  }
  return printable / text.length >= 0.9;
}

/** Bytes to text: transparently decompresses (gzip, zlib, raw deflate, brotli), then insists on valid, readable UTF-8. */
export function decodeBytes(bytes: Uint8Array): { text: string; gunzipped: boolean; how: string } | null {
  const asText = (buf: Buffer): string | null => {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return null;
    }
    // Decoded bytes must be real text: control characters mean binary (for example protobuf).
    return isCleanText(text) ? text : null;
  };
  const buf = Buffer.from(bytes);
  const attempts: [string, () => Buffer][] = [];
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) attempts.push(['decompressed (gzip)', () => gunzipSync(buf)]);
  else if (buf.length > 2 && buf[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[1]!)) {
    attempts.push(['decompressed (deflate)', () => inflateSync(buf)]);
  } else {
    const plain = asText(buf);
    if (plain !== null) return { text: plain, gunzipped: false, how: '' };
    // No magic number: brotli and raw deflate can only be recognised by trying.
    attempts.push(['decompressed (brotli)', () => brotliDecompressSync(buf)], ['decompressed (deflate)', () => inflateRawSync(buf)]);
  }
  for (const [how, run] of attempts) {
    let out: Buffer;
    try {
      out = run();
    } catch {
      continue;
    }
    const text = out.length ? asText(out) : null;
    if (text !== null) return { text, gunzipped: true, how };
  }
  return null;
}
