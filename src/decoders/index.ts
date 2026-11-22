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
export function identify(record: RequestRecord): Identified | undefined {
  const input = toInput(record);
  if (!input) return undefined;
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
