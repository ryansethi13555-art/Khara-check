import { allParams, fieldHead, get, pickFields, type Decoder, type DecoderInput } from './types.js';

const GA4_PARAMS: Record<string, string> = {
  dl: 'address of the page the customer is on',
  dr: 'address of the page they came from',
  dt: 'title of the page',
  uid: 'the site\'s own ID for this customer',
};

/** Google Analytics 4: /g/collect, one event in the URL or several events as lines in the body. */
export const ga4: Decoder = {
  id: 'ga4',
  vendor: 'Google',
  product: 'Google Analytics 4',
  category: 'analytics',
  domains: ['google-analytics.com', 'analytics.google.com'],
  basis: 'vendor-documented',
  matches: (i) => /\/g\/collect$/.test(i.path) || /\/(j\/)?collect$/.test(i.path),
  decode(input) {
    const universal = !/\/g\/collect$/.test(input.path);
    const events = [get(input.query, 'en'), ...input.bodyLines.map((line) => get(line, 'en'))].filter(Boolean) as string[];
    const everything = [...input.query, ...input.bodyLines.flat()];
    return {
      purpose: universal
        ? 'Reports page activity to Google Analytics (older "Universal Analytics" format)'
        : 'Reports page activity to Google Analytics',
      ...(events.length ? { eventName: events.join(', ') } : universal && get(everything, 't') ? { eventName: get(everything, 't')! } : {}),
      ...(get(input.query, 'tid') ? { accountId: get(input.query, 'tid')! } : {}),
      fields: pickFields(everything, GA4_PARAMS, { 'ep.': 'event detail', 'epn.': 'event detail (number)', 'up.': 'customer property' }),
      identifiers: pickFields(everything, {
        cid: 'Google Analytics client ID (_ga cookie): lets Google recognise this browser again',
        sid: 'session ID',
        gclid: 'Google ad click ID',
      }),
    };
  },
  meaning(field) {
    const { head, rest } = fieldHead(field);
    const ep = /^ep\.(.+)$/.exec(head);
    if (ep && /^(mobile|phone|phone_number|email|user_email)$/i.test(ep[1]!)) return `an event detail named "${ep[1]}" holding the customer's contact detail`;
    if (ep) return ep[1] === 'search_term' ? 'the search text of a "view_search_results" event' : `event detail "${ep[1]}"`;
    const up = /^up\.(.+)$/.exec(head);
    if (up) return `customer property "${up[1]}"`;
    if (head === 'dl') return rest.length ? `the page address, which contains it (parameter "${rest.join(' › ')}")` : 'the page address';
    if (head === 'dr') return 'the address of the previous page, which contains it';
    if (head === 'dt') return 'the page title';
    if (head === 'dp') return 'the page path';
    return undefined;
  },
};

const isAdsPath = (i: DecoderInput): boolean =>
  /^\/pagead\/|^\/ccm\/|^\/activity|^\/ddm\/|^\/td\//.test(i.path) ||
  /(^|\.)doubleclick\.net$/.test(i.host) ||
  /(^|\.)googleadservices\.com$/.test(i.host) ||
  /(^|\.)googlesyndication\.com$/.test(i.host);

/** Google Ads and DoubleClick: conversion, remarketing and Floodlight hits. */
export const googleAds: Decoder = {
  id: 'google-ads',
  vendor: 'Google',
  product: 'Google Ads',
  category: 'advertising',
  domains: ['doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'google.com', 'google.co.in'],
  basis: 'vendor-documented',
  matches: isAdsPath,
  decode(input) {
    const p = allParams(input);
    const kind = /viewthroughconversion|1p-user-list|\/rmkt\//.test(input.path)
      ? 'Adds this visit to a Google Ads audience (remarketing), so ads can follow the customer'
      : /\/conversion\//.test(input.path)
        ? 'Reports a conversion (for example a signup or purchase) to Google Ads'
        : /^\/activity|^\/ddm\//.test(input.path)
          ? 'Reports an activity to Google\'s Floodlight ad measurement'
          : 'Reports page activity to Google\'s advertising systems';
    const id = /\/(?:conversion|viewthroughconversion|1p-user-list)\/(\d+)/.exec(input.path)?.[1];
    const data = get(p, 'data');
    const eventName = data ? /(?:^|;)event=([^;]+)/.exec(data)?.[1] : undefined;
    return {
      purpose: kind,
      ...(eventName ? { eventName } : {}),
      ...(id ? { accountId: `AW-${id}` } : {}),
      fields: pickFields(p, {
        url: 'address of the page the customer is on',
        ref: 'address of the page they came from',
        tiba: 'title of the page',
        data: 'event name and details',
        em: 'hashed customer details for "enhanced conversions"',
        label: 'which conversion this is',
      }),
      identifiers: pickFields(p, { gclid: 'Google ad click ID', auid: 'Google Ads browser ID (_gcl_au cookie)' }),
    };
  },
  meaning(field) {
    const { head, rest } = fieldHead(field);
    if (head === 'data') return rest.length ? `event detail "${rest.join(' › ')}"` : 'the event details';
    if (head === 'em') return 'hashed customer details sent for "enhanced conversions", so Google can link the visit to a Google account';
    if (head === 'url') return rest.length ? `the page address, which contains it (parameter "${rest.join(' › ')}")` : 'the page address';
    if (head === 'ref') return 'the address of the previous page, which contains it';
    if (head === 'tiba') return 'the page title';
    if (/^u\d+$/.test(head)) return `custom Floodlight variable "${head}"`;
    return undefined;
  },
};

export const googleTagManager: Decoder = {
  id: 'google-tag-manager',
  vendor: 'Google',
  product: 'Google Tag Manager',
  category: 'tag-manager',
  domains: ['googletagmanager.com'],
  basis: 'vendor-documented',
  decode(input) {
    const id = get(input.query, 'id');
    return {
      purpose: /\/gtag\/js/.test(input.path)
        ? 'Loads Google\'s tag (gtag.js), which then runs Google Analytics and Google Ads'
        : 'Loads the site\'s tag container, which can load any number of other trackers',
      ...(id ? { accountId: id } : {}),
    };
  },
};
