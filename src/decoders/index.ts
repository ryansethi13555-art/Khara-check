import type { DecodedCall, RequestRecord, VendorCategory } from '../types.js';
import { hostMatches } from '../util/domains.js';
import { DIRECTORY } from './directory.js';
import { cleverTap, moEngage, netcore, webEngage } from './engagement.js';
import { ga4, googleAds, googleTagManager } from './google.js';
import { metaPixel } from './meta.js';
import { appsFlyer, branch, clarity, criteo, hotjar, taboola } from './others.js';
import { redditPixel } from './reddit.js';
import { toInput, type Decoder } from './types.js';

/** Order matters where domains overlap: narrower decoders first. */
export const DECODERS: Decoder[] = [
  metaPixel,
  redditPixel,
  ga4,
  googleTagManager,
  googleAds,
  cleverTap,
  moEngage,
  webEngage,
  netcore,
  clarity,
  hotjar,
  branch,
  appsFlyer,
  criteo,
  taboola,
];

export interface Identified {
  vendor: string;
  product: string;
  category: VendorCategory;
  decoder?: Decoder;
  call?: DecodedCall;
}

/** Says who a request went to and, where a decoder exists, what it carried. */
/**
 * Names the company behind a request. `host` overrides the request's own hostname, for a
 * site-looking hostname that DNS shows is an alias for another company's server.
 */
export function identify(record: RequestRecord, host?: string): Identified | undefined {
  const parsed = toInput(record);
  if (!parsed) return undefined;
  const input = host ? { ...parsed, host } : parsed;
  for (const decoder of DECODERS) {
    if (!decoder.domains.some((d) => hostMatches(input.host, d))) continue;
    if (decoder.matches && !decoder.matches(input)) continue;
    let result;
    try {
      result = decoder.decode(input);
    } catch {
      result = { purpose: `A request to ${decoder.product}` };
    }
    return {
      vendor: decoder.vendor,
      product: decoder.product,
      category: decoder.category,
      decoder,
      call: {
        decoder: decoder.id,
        vendor: decoder.vendor,
        product: decoder.product,
        category: decoder.category,
        purpose: result.purpose,
        ...(result.eventName ? { eventName: result.eventName } : {}),
        ...(result.accountId ? { accountId: result.accountId } : {}),
        fields: result.fields ?? [],
        identifiers: result.identifiers ?? [],
      },
    };
  }
  const entry = DIRECTORY.find((e) => e.domains.some((d) => hostMatches(input.host, d)));
  return entry ? { vendor: entry.vendor, product: entry.product, category: entry.category } : undefined;
}

/**
 * Data collection services that a site can run at its own address (a custom domain or a
 * server-side tag manager). A request with one of these shapes is still sent to the site,
 * but what happens to the data next is decided on a server the browser cannot see.
 */
export function collectorShape(record: RequestRecord): { vendor: string; product: string } | undefined {
  const input = toInput(record);
  if (!input || input.record.method === 'OPTIONS') return undefined;
  const { path, bodyText, query } = input;
  const headers = record.requestHeaders;
  if (/^\/v1\/(page|track|identify|batch|screen|group|alias)$/.test(path) && (headers.anonymousid !== undefined || /rudder/i.test(bodyText))) {
    return { vendor: 'RudderStack', product: 'RudderStack data plane' };
  }
  if (/^\/v1\/(t|p|i|g|a|s|b|track|page|identify|batch)$/.test(path) && /"library"\s*:\s*\{\s*"name"\s*:\s*"analytics(\.js|-next)/.test(bodyText)) {
    return { vendor: 'Segment', product: 'Segment' };
  }
  if (/\/g\/collect$/.test(path) && query.some(([k, v]) => k === 'tid' && /^G-/.test(v)) && query.some(([k, v]) => k === 'v' && v === '2')) {
    return { vendor: 'Google', product: 'Google Analytics 4 (server-side tagging)' };
  }
  if (/\/com\.snowplowanalytics\.snowplow\/tp2$|^\/i$/.test(path) && /snowplow|"schema"\s*:\s*"iglu:/.test(bodyText + query.map(([, v]) => v).join(' '))) {
    return { vendor: 'Snowplow', product: 'Snowplow' };
  }
  return undefined;
}
