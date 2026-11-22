import { allParams, clip, fieldHead, get, pickFields, type Decoder } from './types.js';

export const clarity: Decoder = {
  id: 'microsoft-clarity',
  vendor: 'Microsoft',
  product: 'Microsoft Clarity',
  category: 'session-replay',
  domains: ['clarity.ms'],
  basis: 'observed-shape',
  decode(input) {
    return /\/collect$/.test(input.path)
      ? { purpose: 'Uploads a recording of the session (clicks, scrolling, and page content) to Microsoft Clarity' }
      : { purpose: 'Loads Microsoft Clarity, a tool that records how visitors use the page' };
  },
  meaning: () => 'the recorded page content or typing',
};

export const hotjar: Decoder = {
  id: 'hotjar',
  vendor: 'Hotjar',
  product: 'Hotjar',
  category: 'session-replay',
  domains: ['hotjar.com', 'hotjar.io'],
  basis: 'observed-shape',
  decode(input) {
    return /\.js$/.test(input.path) || /^static\.|^script\./.test(input.host)
      ? { purpose: 'Loads Hotjar, a tool that records how visitors use the page' }
      : { purpose: 'Uploads session activity (clicks, scrolling, and page content) to Hotjar' };
  },
  meaning: () => 'the recorded page content or typing',
};

export const branch: Decoder = {
  id: 'branch',
  vendor: 'Branch',
  product: 'Branch',
  category: 'attribution',
  domains: ['branch.io', 'app.link'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the Branch code onto the page' };
    const p = allParams(input);
    const body: any = input.bodyJson;
    const name = get(p, 'name') ?? get(p, 'event') ?? body?.name ?? body?.event;
    return {
      purpose: 'Reports activity to Branch, which links web visits to app installs and ad clicks',
      ...(name ? { eventName: String(name) } : {}),
      fields: pickFields(p, { custom_data: 'event details', event_data: 'event details', content_items: 'items viewed', metadata: 'event details' }),
      identifiers: pickFields(p, { browser_fingerprint_id: 'Branch ID for this browser', identity_id: 'Branch ID for this customer', developer_identity: 'the site\'s own ID for this customer' }),
    };
  },
  meaning(field) {
    const { head, rest } = fieldHead(field);
    if (/search_query/.test(field)) return 'the search text of a search event';
    if (['custom_data', 'event_data', 'metadata'].includes(head)) return rest.length ? `event detail "${rest.join('.')}"` : 'the event details';
    return undefined;
  },
};

export const appsFlyer: Decoder = {
  id: 'appsflyer',
  vendor: 'AppsFlyer',
  product: 'AppsFlyer',
  category: 'attribution',
  domains: ['appsflyer.com', 'onelink.me'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the AppsFlyer code onto the page' };
    const body: any = input.bodyJson;
    const name = body?.eventName ?? body?.event_name ?? get(allParams(input), 'eventName');
    return {
      purpose: 'Reports activity to AppsFlyer, which links web visits to app installs and ad clicks',
      ...(name ? { eventName: String(name) } : {}),
      fields: body?.eventValue ? [{ name: 'eventValue', value: clip(JSON.stringify(body.eventValue)), meaning: 'event details' }] : [],
      identifiers: body?.customerUserId ? [{ name: 'customerUserId', value: String(body.customerUserId), meaning: 'the site\'s own ID for this customer' }] : [],
    };
  },
  meaning(field) {
    if (/eventValue/.test(field)) return 'the details of an event';
    return undefined;
  },
};

export const criteo: Decoder = {
  id: 'criteo',
  vendor: 'Criteo',
  product: 'Criteo OneTag',
  category: 'advertising',
  domains: ['criteo.com', 'criteo.net'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the Criteo code onto the page' };
    const p = allParams(input);
    const events = p.filter(([k]) => /^p\d+$/.test(k)).map(([, v]) => /(?:^|&)e=([^&]+)/.exec(v)?.[1]).filter(Boolean);
    const names: Record<string, string> = { vl: 'viewList (a search or listing page)', vp: 'viewItem', vb: 'viewBasket', vh: 'viewHome', vo: 'trackTransaction' };
    return {
      purpose: 'Reports what the customer looked at to Criteo, an ad retargeting company',
      ...(events.length ? { eventName: events.map((e) => names[e!] ?? e).join(', ') } : {}),
      ...(get(p, 'a') ? { accountId: get(p, 'a')! } : {}),
      fields: pickFields(p, {}, { p: 'event details' }),
    };
  },
  meaning(field) {
    const { head, rest } = fieldHead(field);
    if (/^p\d+$/.test(head) && rest[0] === 'kw') return 'the search keywords of a listing-page event';
    if (/^p\d+$/.test(head)) return rest.length ? `event detail "${rest.join('.')}"` : 'the event details';
    return undefined;
  },
};

export const taboola: Decoder = {
  id: 'taboola',
  vendor: 'Taboola',
  product: 'Taboola Pixel',
  category: 'advertising',
  domains: ['taboola.com'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the Taboola code onto the page' };
    const p = allParams(input);
    return {
      purpose: 'Reports page activity to Taboola, an advertising network',
      ...(get(p, 'en') ? { eventName: get(p, 'en')! } : {}),
      ...(/^\/(\d+)\//.exec(input.path)?.[1] ? { accountId: /^\/(\d+)\//.exec(input.path)![1]! } : {}),
      fields: pickFields(p, { 'item-url': 'address of the page the customer is on', ref: 'address of the page they came from' }),
    };
  },
  meaning(field) {
    const { head } = fieldHead(field);
    if (head === 'item-url') return 'the page address, which contains it';
    return undefined;
  },
};
