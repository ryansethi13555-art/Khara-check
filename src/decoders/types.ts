import LZString from 'lz-string';
import { decodeBytes } from '../canary/unfold.js';
import type { DecodedCall, DecodedField, RequestRecord, VendorCategory } from '../types.js';

/** A request, pre-parsed once so each decoder stays small. */
export interface DecoderInput {
  record: RequestRecord;
  host: string;
  path: string;
  /** Decoded query parameters, in order. */
  query: [string, string][];
  bodyText: string;
  /** Body parsed as form fields (or as one event per line, for batched hits). */
  bodyLines: [string, string][][];
  bodyJson: unknown;
}

export interface DecodeResult {
  purpose: string;
  eventName?: string;
  accountId?: string;
  fields?: DecodedField[];
  identifiers?: DecodedField[];
}

export interface Decoder {
  id: string;
  vendor: string;
  product: string;
  category: VendorCategory;
  /** Domains this decoder speaks for. A host matches if it equals one or is a subdomain of it. */
  domains: string[];
  /** Optional narrower test (path shape), when one domain serves several products. */
  matches?(input: DecoderInput): boolean;
  decode(input: DecoderInput): DecodeResult;
  /**
   * Plain-language meaning of a field path as reported by the matcher,
   * e.g. "cd[search_string]" or "dl › q". Used to explain a finding to a non-technical reader.
   */
  meaning?(field: string, surface: string): string | undefined;
  /** How sure we are that this decoder matches what the vendor really sends today. */
  basis: 'vendor-documented' | 'observed-shape' | 'domain-only';
}

export function bodyTextOf(record: RequestRecord): string {
  const p = record.postData;
  if (!p) return '';
  if (p.encoding === 'utf8') return p.text;
  return decodeBytes(Buffer.from(p.text, 'base64'))?.text ?? '';
}

function parsePairs(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const segment of text.split('&')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    const dec = (s: string): string => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    out.push(eq === -1 ? [dec(segment), ''] : [dec(segment.slice(0, eq)), dec(segment.slice(eq + 1))]);
  }
  return out;
}

export function toInput(record: RequestRecord): DecoderInput | null {
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return null;
  }
  const bodyText = bodyTextOf(record);
  let bodyJson: unknown;
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      bodyJson = JSON.parse(trimmed);
    } catch {
      bodyJson = undefined;
    }
  }
  const bodyLines =
    bodyJson === undefined && /^[^=&\s]+=/.test(trimmed)
      ? trimmed.split(/\r?\n/).filter(Boolean).map(parsePairs)
      : [];
  return {
    record,
    host: url.hostname.toLowerCase(),
    path: url.pathname,
    query: parsePairs(url.search.replace(/^\?/, '')),
    bodyText,
    bodyLines,
    bodyJson,
  };
}

// ---- small helpers shared by decoders -----------------------------------------------------

export const get = (pairs: [string, string][], key: string): string | undefined =>
  pairs.find(([k]) => k === key)?.[1];

/** Query parameters followed by form-body parameters (first body line). */
export const allParams = (input: DecoderInput): [string, string][] => [...input.query, ...(input.bodyLines[0] ?? [])];

export function pickFields(
  pairs: [string, string][],
  meanings: Record<string, string>,
  prefixes: Record<string, string> = {},
): DecodedField[] {
  const out: DecodedField[] = [];
  for (const [name, value] of pairs) {
    if (!value) continue;
    const exact = meanings[name];
    const prefix = Object.keys(prefixes).find((p) => name.startsWith(p));
    if (exact) out.push({ name, value: clip(value), meaning: exact });
    else if (prefix) out.push({ name, value: clip(value), meaning: prefixes[prefix]! });
  }
  return out;
}

export const clip = (value: string, max = 160): string => (value.length > max ? value.slice(0, max) + '…' : value);

/** First segment of a field path such as "dl › q" or "line 2 › ep.search_term". */
export function fieldHead(field: string): { head: string; rest: string[] } {
  const parts = field.split(' › ').filter((p) => !/^line \d+$/.test(p));
  return { head: parts[0] ?? '', rest: parts.slice(1) };
}

export function jsonAt(value: unknown, ...keys: string[]): unknown {
  let v: any = value;
  for (const k of keys) v = v?.[k];
  return v;
}

/** Decodes the wrapped event payloads used by engagement SDKs: base64(JSON) or LZ-string(JSON). */
export function unwrapJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const t = text.trim().replace(/ /g, '+');
  for (const attempt of [
    (): string | null => decodeBytes(Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))?.text ?? null,
    (): string | null => LZString.decompressFromBase64(t),
    (): string | null => LZString.decompressFromEncodedURIComponent(t),
  ]) {
    try {
      const out = attempt();
      if (out && /^[[{]/.test(out.trim())) return JSON.parse(out);
    } catch {
      /* try the next wrapping */
    }
  }
  return undefined;
}

export type { DecodedCall };
