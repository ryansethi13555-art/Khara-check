import { createHash } from 'node:crypto';
import { generateCanary } from '../canary/generate.js';
import { seededRng } from '../util/random.js';
import type { Journey } from '../journey/schema.js';
import { hostMatches, hostOf, registrableDomain } from '../util/domains.js';
import { ownHosts, resolveAliases } from '../capture/dns.js';
import { TOOL } from '../version.js';
import type { Canary, Initiator, PostData, RequestRecord, RunInfo, StepRecord } from '../types.js';

/**
 * Reads a HAR file (the "Save all as HAR" export of Chrome, Edge, Firefox or Safari DevTools)
 * and turns it into the same records an automated run produces, so the same matcher, decoders,
 * evidence bundle and report apply to traffic a person recorded by hand, before Khara Check existed.
 *
 * What a HAR cannot prove is said in the report: Khara Check did not watch the recording, so the
 * evidence is sealed from the moment of import, and the values are the ones the person says
 * they typed.
 */

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    httpVersion?: string;
    headers?: HarHeader[];
    postData?: { mimeType?: string; text?: string; params?: { name: string; value?: string }[]; _encoding?: string; encoding?: string };
  };
  response?: {
    status: number;
    statusText?: string;
    httpVersion?: string;
    headers?: HarHeader[];
    content?: { mimeType?: string };
    _error?: string | null;
  };
  serverIPAddress?: string;
  _resourceType?: string;
  _initiator?: {
    type?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stack?: HarStack;
  };
  _webSocketMessages?: { type: string; time: number; opcode: number; data: string }[];
}

interface HarStack {
  callFrames?: { url?: string }[];
  parent?: HarStack;
}

export interface HarFile {
  log: {
    creator?: { name?: string; version?: string };
    browser?: { name?: string; version?: string };
    pages?: { id: string; startedDateTime: string; title?: string }[];
    entries: HarEntry[];
  };
}

export interface ImportResult {
  run: RunInfo;
  canaries: Canary[];
  records: RequestRecord[];
  cookies: unknown[];
}

export function parseHar(text: string, name = 'the file'): HarFile {
  let har: HarFile;
  try {
    har = JSON.parse(text.replace(/^﻿/, '')) as HarFile;
  } catch (err) {
    throw new Error(`${name} is not a HAR file: it is not valid JSON (${(err as Error).message})`);
  }
  if (!har?.log || !Array.isArray(har.log.entries)) throw new Error(`${name} is not a HAR file: it has no "log.entries" list`);
  if (!har.log.entries.length) throw new Error(`${name} holds no requests. Record the journey with DevTools open, then "Save all as HAR".`);
  return har;
}

function headerMap(headers: HarHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const key = h.name.toLowerCase();
    out[key] = key in out ? `${out[key]}\n${h.value}` : h.value;
  }
  return out;
}

function postDataOf(entry: HarEntry): PostData | undefined {
  const pd = entry.request.postData;
  if (!pd) return undefined;
  let text = pd.text;
  if (text === undefined && pd.params?.length) {
    text = pd.params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value ?? '')}`).join('&');
  }
  if (text === undefined || text === '') return undefined;
  const base64 = (pd._encoding ?? pd.encoding) === 'base64';
  const bytes = base64 ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8');
  return {
    encoding: base64 ? 'base64' : 'utf8',
    text,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function stackUrls(stack: HarStack | undefined): string[] {
  const urls: string[] = [];
  for (let s = stack; s; s = s.parent) {
    for (const f of s.callFrames ?? []) if (f.url && !urls.includes(f.url)) urls.push(f.url);
  }
  return urls;
}

function initiatorOf(entry: HarEntry): Initiator | undefined {
  const i = entry._initiator;
  if (!i?.type) return undefined;
  const stack = stackUrls(i.stack);
  return {
    type: i.type,
    ...(i.url ? { url: i.url } : stack[0] ? { url: stack[0] } : {}),
    ...(typeof i.lineNumber === 'number' ? { lineNumber: i.lineNumber } : {}),
    ...(typeof i.columnNumber === 'number' ? { columnNumber: i.columnNumber } : {}),
    ...(stack.length ? { stack } : {}),
  };
}

const wsData = (data: string): PostData => {
  const bytes = Buffer.from(data, 'utf8');
  return { encoding: 'utf8', text: data, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

export function importHar(
  har: HarFile,
  journey: Journey,
  opts: { fileName: string; importedAt?: number; dns?: Record<string, string[]> },
): ImportResult {
  if (journey.network.mode !== 'live') throw new Error('a HAR file records the real internet, so the site must be given as a live address');
  const origin = new URL(journey.site.url!).origin;

  // A HAR records the past: every value must be the one the person actually typed.
  const canaries = Object.entries(journey.canaries).map(([name, spec]) => {
    if (spec.value === undefined && spec.valueFromEnv === undefined) {
      throw new Error(`say exactly what was typed for "${name}": a HAR file records the past, so Khara Check cannot plant a new value`);
    }
    return generateCanary(name, spec, { rng: seededRng('import'), allowGeneratedPhone: false });
  });

  const entries = [...har.log.entries]
    .map((e, i) => ({ e, i, t: Date.parse(e.startedDateTime) }))
    .filter((x) => Number.isFinite(x.t) && /^(https?|wss?):/i.test(x.e.request.url))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  if (!entries.length) throw new Error(`${opts.fileName} has no web requests with a usable time`);

  // Each page the person opened becomes a step, so findings say which page they happened on.
  const pages = [...(har.log.pages ?? [])]
    .map((p) => ({ ...p, t: Date.parse(p.startedDateTime) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const steps: StepRecord[] = [];
  const stepOfPage = new Map<string, number>();
  const first = entries[0]!.t;
  const last = entries[entries.length - 1]!.t;
  for (const p of pages) {
    const docUrl = entries.find((x) => x.e.pageref === p.id && x.e._resourceType === 'document')?.e.request.url ?? '';
    const title = (p.title ?? '').trim();
    stepOfPage.set(p.id, steps.length);
    steps.push({
      index: steps.length,
      action: 'page',
      label: title && !/^https?:\/\//i.test(title) ? `Opened "${title}"` : `Opened ${shortUrl(docUrl || title || 'a page')}`,
      startedAt: p.t,
      endedAt: p.t,
      pageUrl: docUrl || (/^https?:\/\//i.test(title) ? title : ''),
      ok: true,
      actor: 'person',
    });
  }
  if (!steps.length) {
    steps.push({ index: 0, action: 'page', label: 'Browsed the site (the HAR file names no pages)', startedAt: first, endedAt: first, pageUrl: origin, ok: true, actor: 'person' });
  }
  for (let i = 0; i < steps.length; i++) steps[i]!.endedAt = steps[i + 1]?.startedAt ?? last;

  const stepAt = (t: number): number => {
    let idx = -1;
    for (const s of steps) if (s.startedAt <= t) idx = s.index;
    return idx;
  };

  const records: RequestRecord[] = entries.map(({ e, t }, i) => {
    const ws = /^wss?:/i.test(e.request.url) || e._resourceType === 'websocket';
    const postData = postDataOf(e);
    const initiator = initiatorOf(e);
    const failure = e.response?._error || (e.response && e.response.status === 0 ? 'no response (blocked, cancelled or failed)' : undefined);
    const record: RequestRecord = {
      id: `r${String(i + 1).padStart(4, '0')}`,
      seq: i,
      kind: ws ? 'websocket' : 'http',
      source: 'har',
      method: e.request.method || 'GET',
      url: e.request.url,
      resourceType: (e._resourceType ?? 'other').toLowerCase(),
      wallTime: t,
      pageIndex: 0,
      requestHeaders: headerMap(e.request.headers),
      headersSource: 'wire',
      ...(postData ? { postData } : {}),
      ...(initiator ? { initiator } : {}),
      ...(e.response && e.response.status > 0
        ? {
            response: {
              status: e.response.status,
              statusText: e.response.statusText ?? '',
              headers: headerMap(e.response.headers),
              ...(e.response.content?.mimeType ? { mimeType: e.response.content.mimeType } : {}),
              ...(e.serverIPAddress ? { remoteAddress: e.serverIPAddress } : {}),
              ...(e.response.httpVersion ? { protocol: e.response.httpVersion } : {}),
            },
          }
        : {}),
      ...(failure ? { failure } : {}),
      step: e.pageref && stepOfPage.has(e.pageref) ? Math.max(stepOfPage.get(e.pageref)!, stepAt(t)) : stepAt(t),
    };
    if (ws) {
      const sent = (e._webSocketMessages ?? []).filter((m) => m.type === 'send' && m.opcode !== 2 && typeof m.data === 'string');
      if (sent.length) record.framesSent = sent.map((m) => ({ wallTime: Math.round(m.time * 1000), postData: wsData(m.data) }));
    }
    return record;
  });

  const ua = records.find((r) => r.requestHeaders['user-agent'])?.requestHeaders['user-agent'] ?? '';
  const browser = har.log.browser?.name ?? har.log.creator?.name ?? 'unknown';
  const siteHost = hostOf(origin);
  const run: RunInfo = {
    tool: TOOL,
    journeyName: journey.name,
    site: {
      name: journey.site.name,
      origin,
      firstPartyDomains: [...new Set([registrableDomain(siteHost), ...journey.site.firstParty.map((d) => d.toLowerCase())])],
    },
    mode: 'live',
    capture: 'imported',
    startedAt: first,
    endedAt: last,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      playwright: 'not used',
      browser,
      browserVersion: har.log.browser?.version ?? har.log.creator?.version ?? 'unknown',
      userAgent: ua,
      viewport: { width: 0, height: 0 },
      locale: journey.browser.locale,
      timezone: journey.browser.timezone,
      headless: /Headless/.test(ua),
    },
    steps,
    notes: [
      `Imported from the HAR file ${opts.fileName} on ${new Date(opts.importedAt ?? Date.now()).toISOString()}. The original file is kept, unchanged, at capture/original.har.`,
      'A person recorded this traffic in their own browser. Khara Check did not watch the recording, so the seal proves the evidence has not changed since it was imported, not since it was recorded.',
      'The planted values are the ones the person says they typed.',
      ...(opts.dns && Object.keys(opts.dns).length ? ['DNS aliases of the site\'s own hostnames were looked up at import time, not when the traffic was recorded.'] : []),
    ],
    ...(opts.dns && Object.keys(opts.dns).length ? { dns: opts.dns } : {}),
  };
  return { run, canaries, records, cookies: [] };
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = u.pathname + u.search;
    return u.host + (rest.length > 60 ? rest.slice(0, 57) + '…' : rest);
  } catch {
    return url;
  }
}
