import { toInput } from '../decoders/types.js';
import type { RequestRecord, RunInfo } from '../types.js';
import { hostMatches, hostOf, registrableDomain } from '../util/domains.js';

/**
 * Google server-side tagging (SST, "server-side Google Tag Manager").
 *
 * With SST, the page sends its Google Analytics hits to a server the site controls, usually at
 * one of its own subdomains (`sgtm.example.com/g/collect`), and that server passes the data on to
 * Google and other companies. The browser never sees the second leg, so the usual check, "which
 * outside companies did the page contact", misses it.
 *
 * The detection follows the method of Moti, Frings, Utz, Zuiderveen Borgesius and Acar, "The
 * Bitter Pill: Tracking and Remarketing on EU Pharmacy Websites" (section 3.4): when the endpoint
 * moves, the URL parameters the Google tag sends stay the same. So a request to a host that is
 * not Google's, carrying Google's tag parameters, is an SST endpoint, whatever its path. The paper
 * confirms each one with the request initiator (SST runs on Google Tag Manager) and with who
 * hosts the server; this module records the same two confirmations from the capture.
 *
 * The paper did not publish its list of 36 parameters. The list below is our own, built the same
 * way: the parameters present on at least 80% of the 109 Google Analytics 4 page hits recorded by
 * Khara Check on eight Indian pharmacy and lab sites in November 2026.
 */
export const GA4_TAG_PARAMS = [
  'v', 'tid', 'gtm', '_p', 'gcd', 'npa', 'dma', 'cid', 'ul', 'sr',
  'uaa', 'uab', 'uafvl', 'uamb', 'uam', 'uap', 'uapv', 'uaw', 'frm', 'pscdl',
  '_eu', '_s', 'sid', 'sct', 'seg', 'dl', 'dt', 'tfd', 'tag_exp', 'rcb',
] as const;

/** How many of GA4_TAG_PARAMS a request must carry, on top of `v=2` and a `G-` measurement ID. */
export const MIN_TAG_PARAMS = 12;

/** Google's own collection and tag hosts: a Google tag sending here is ordinary, client-side tagging. */
const GOOGLE_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'googleapis.com',
  'gstatic.com',
];
const isGoogleHost = (host: string): boolean =>
  GOOGLE_HOSTS.some((d) => hostMatches(host, d)) || /(^|\.)google\.[a-z.]+$/.test(host);

/** A Google Tag Manager or Google tag (gtag.js) script, wherever it is served from. */
const TAG_SCRIPT = /\/(gtm|gtag)\.js(\?|$)|\/gtag\/js(\?|$)|[?&]id=(GTM|G|AW|DC)-[A-Z0-9]+/i;

/** DNS targets that mean the endpoint runs on Google Cloud or on a hosted SST service. */
const SST_HOSTING: { pattern: RegExp; label: string }[] = [
  { pattern: /(^|\.)run\.app$/, label: 'Google Cloud Run' },
  { pattern: /(^|\.)appspot\.com$/, label: 'Google App Engine' },
  { pattern: /(^|\.)ghs\.googlehosted\.com$/, label: 'Google-hosted (ghs.googlehosted.com)' },
  { pattern: /(^|\.)stape\.(io|net)$/, label: 'Stape (server-side tagging host)' },
];

export interface SstEndpoint {
  /** The hostname the page sent Google tag hits to. */
  host: string;
  /** "first": the site's own address. "other": a host that is neither the site's nor Google's. */
  party: 'first' | 'other';
  paths: string[];
  /** GA4 measurement IDs (G-...) seen in the hits. */
  measurementIds: string[];
  requests: number;
  requestIds: string[];
  /** The Google tag parameters found, out of GA4_TAG_PARAMS (the most seen on any one request). */
  tagParams: string[];
  /** Tag Manager or gtag.js scripts on the call stack of these requests (the paper's initiator check). */
  tagScripts: string[];
  /** Tag scripts served from somewhere other than Google (a self-hosted Tag Manager). */
  selfHostedTagScripts: string[];
  /** Signs, from the capture, of who runs the server. */
  hosting: string[];
  /**
   * True for Google tag gateway ("first-party mode"): a CDN such as Cloudflare forwards a path on
   * the site's own domain (`/x7qa/ag/g/c`) to Google, instead of a tagging server the site runs.
   * It hides the Google leg from the browser in the same way.
   */
  gateway: boolean;
  /** Server IP addresses the browser connected to, for a WHOIS lookup. */
  addresses: string[];
  /**
   * "confirmed": the parameters match and the initiator or the hosting confirms it.
   * "likely": the parameters match, with no second sign in the capture.
   */
  confidence: 'confirmed' | 'likely';
}

function paramsOf(record: RequestRecord): { keys: Set<string>; tid?: string; v?: string } {
  const input = toInput(record);
  const pairs: [string, string][] = input ? [...input.query, ...input.bodyLines.flat()] : [];
  const keys = new Set(pairs.map(([k]) => k));
  const tid = pairs.find(([k]) => k === 'tid')?.[1];
  const v = pairs.find(([k]) => k === 'v')?.[1];
  return { keys, ...(tid !== undefined ? { tid } : {}), ...(v !== undefined ? { v } : {}) };
}

/** True when the request carries the Google tag's GA4 parameters (section 3.4 of the paper). */
export function hasGoogleTagShape(record: RequestRecord): boolean {
  const { keys, tid, v } = paramsOf(record);
  if (v !== '2' || !tid || !/^G-[A-Z0-9]+$/i.test(tid)) return false;
  return GA4_TAG_PARAMS.filter((p) => keys.has(p)).length >= MIN_TAG_PARAMS;
}

/**
 * The path prefix of a Google tag gateway endpoint: the part before the gateway's own collect
 * paths (`/x7qa/` in `/x7qa/ag/g/c` or `/x7qa/g/collect`). Undefined for an ordinary endpoint at
 * the root of its host.
 */
export function gatewayPrefix(path: string): string | undefined {
  const m = /^(\/[^/]+\/)(ag\/)?g\/(c|collect)$/.exec(path);
  return m && (m[2] || m[3] === 'c') ? m[1] : undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function header(record: RequestRecord, name: string): string {
  const headers = record.response?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key]! : '';
}

/**
 * Finds Google server-side tagging endpoints in a capture. A pure function of the evidence,
 * like `analyze`: DNS aliases come from `run.dns`, recorded when the capture was made.
 */
export function detectServerSideTagging(run: RunInfo, records: RequestRecord[]): SstEndpoint[] {
  const siteHost = hostOf(run.site.origin);
  const siteDomain = registrableDomain(siteHost);
  const own = (host: string): boolean =>
    host === siteHost || registrableDomain(host) === siteDomain || run.site.firstPartyDomains.some((d) => hostMatches(host, d));

  const byHost = new Map<string, SstEndpoint & { scripts: Set<string>; selfHosted: Set<string>; cdn?: string }>();
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    if (record.method === 'OPTIONS') continue;
    const host = hostOf(record.url);
    if (!host || isGoogleHost(host) || !hasGoogleTagShape(record)) continue;
    let entry = byHost.get(host);
    if (!entry) {
      entry = {
        host,
        party: own(host) ? 'first' : 'other',
        paths: [],
        measurementIds: [],
        requests: 0,
        requestIds: [],
        tagParams: [],
        tagScripts: [],
        selfHostedTagScripts: [],
        hosting: [],
        gateway: false,
        addresses: [],
        confidence: 'likely',
        scripts: new Set(),
        selfHosted: new Set(),
      };
      byHost.set(host, entry);
    }
    entry.requests++;
    entry.requestIds.push(record.id);
    const path = new URL(record.url).pathname;
    if (!entry.paths.includes(path)) entry.paths.push(path);
    const { keys, tid } = paramsOf(record);
    if (tid && !entry.measurementIds.includes(tid)) entry.measurementIds.push(tid);
    const found = GA4_TAG_PARAMS.filter((p) => keys.has(p));
    if (found.length > entry.tagParams.length) entry.tagParams = [...found];
    const stack = [record.initiator?.url, ...(record.initiator?.stack ?? [])].filter(Boolean) as string[];
    for (const script of stack) {
      if (!TAG_SCRIPT.test(script)) continue;
      const scriptHost = hostOf(script);
      const clean = script.split('#')[0]!;
      entry.scripts.add(clean);
      if (scriptHost && !isGoogleHost(scriptHost)) entry.selfHosted.add(clean);
    }
    const server = header(record, 'server');
    const via = header(record, 'via');
    if (/google frontend/i.test(server) && !entry.hosting.includes('Google Cloud (Server: Google Frontend)')) {
      entry.hosting.push('Google Cloud (Server: Google Frontend)');
    }
    if (/\bgoogle\b/i.test(via) && !entry.hosting.includes(`Google (Via: ${via})`)) entry.hosting.push(`Google (Via: ${via})`);
    if (/cloudflare/i.test(server)) entry.cdn = 'Cloudflare';
    const address = record.response?.remoteAddress?.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (address && !entry.addresses.includes(address)) entry.addresses.push(address);
  }

  // Google tag gateway serves the tag itself, under an obfuscated name, from the same path prefix
  // as the hits (`/x7qa/…` for `/x7qa/ag/g/c`). A script loaded from that prefix on that host, or
  // on that prefix's call stack, confirms the endpoint as the paper's initiator check does.
  for (const entry of byHost.values()) {
    const prefixes = entry.paths.map(gatewayPrefix).filter((p): p is string => Boolean(p));
    if (!prefixes.length) continue;
    entry.gateway = true;
    const fromPrefix = (url: string): boolean => hostOf(url) === entry.host && prefixes.some((p) => pathOf(url).startsWith(p));
    for (const r of records) {
      if (r.resourceType === 'script' && fromPrefix(r.url)) {
        const clean = r.url.split('#')[0]!;
        entry.scripts.add(clean);
        entry.selfHosted.add(clean);
      }
    }
    for (const id of entry.requestIds) {
      const r = records.find((x) => x.id === id);
      for (const script of [r?.initiator?.url, ...(r?.initiator?.stack ?? [])]) {
        if (script && fromPrefix(script)) {
          entry.scripts.add(script.split('#')[0]!);
          entry.selfHosted.add(script.split('#')[0]!);
        }
      }
    }
    if (entry.cdn) entry.hosting.push(`Google tag gateway on ${entry.cdn} (Server: ${entry.cdn.toLowerCase()})`);
  }

  return [...byHost.values()]
    .map(({ scripts, selfHosted, cdn: _cdn, ...e }) => {
      for (const target of run.dns?.[e.host] ?? []) {
        const hit = SST_HOSTING.find((h) => h.pattern.test(target));
        if (hit) e.hosting.push(`${hit.label} (DNS alias ${target})`);
      }
      e.tagScripts = [...scripts].sort();
      e.selfHostedTagScripts = [...selfHosted].sort();
      e.confidence = e.tagScripts.length || e.hosting.length ? 'confirmed' : 'likely';
      return e;
    })
    .sort((a, b) => a.host.localeCompare(b.host));
}
