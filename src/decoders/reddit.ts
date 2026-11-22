import { allParams, fieldHead, get, pickFields, type Decoder } from './types.js';

/** Reddit Pixel: https://alb.reddit.com/rp.gif with event details in m.* and hashed matching keys. */
export const redditPixel: Decoder = {
  id: 'reddit-pixel',
  vendor: 'Reddit',
  product: 'Reddit Pixel',
  category: 'advertising',
  domains: ['reddit.com', 'redditstatic.com', 'redditmedia.com'],
  basis: 'observed-shape',
  matches: (i) => /redditstatic\.com$/.test(i.host) || /^\/rp(\.gif)?$/.test(i.path),
  decode(input) {
    if (/redditstatic\.com$/.test(input.host)) return { purpose: 'Loads the Reddit ad pixel onto the page' };
    const p = allParams(input);
    return {
      purpose: 'Reports an event on this page to Reddit, for ad targeting and measurement',
      ...(get(p, 'event') ? { eventName: get(p, 'event')! } : {}),
      ...(get(p, 'id') ? { accountId: get(p, 'id')! } : {}),
      fields: pickFields(p, {}, { 'm.': 'detail of what the customer did', auto_: 'customer detail picked up by automatic matching' }),
      identifiers: pickFields(p, { uuid: 'Reddit browser ID', 'm.aaid': 'mobile advertising ID' }),
    };
  },
  meaning(field) {
    const { head } = fieldHead(field);
    if (head === 'auto_pn') return 'the customer\'s phone number, picked up from the page by Reddit\'s automatic matching so Reddit can link the visit to a Reddit account';
    if (head === 'auto_em') return 'the customer\'s email address, picked up from the page by Reddit\'s automatic matching';
    if (head === 'm.products') return 'the names of the products on the page';
    if (/^m\./.test(head)) return `event detail "${head.slice(2)}"`;
    return undefined;
  },
};
