import type { VendorCategory } from '../types.js';

/**
 * Companies recognised by domain alone. For these Khara Check can say who owns the address and what
 * the product is for, but does not interpret individual fields. The raw scan still finds any
 * canary sent to them.
 */
export const DIRECTORY: { domains: string[]; vendor: string; product: string; category: VendorCategory }[] = [
  { domains: ['bing.com', 'bat.bing.net'], vendor: 'Microsoft', product: 'Microsoft Advertising (UET)', category: 'advertising' },
  { domains: ['tiktok.com', 'tiktokw.us', 'byteoversea.com'], vendor: 'TikTok', product: 'TikTok Pixel', category: 'advertising' },
  { domains: ['linkedin.com', 'licdn.com'], vendor: 'LinkedIn', product: 'LinkedIn Insight Tag', category: 'advertising' },
  { domains: ['twitter.com', 't.co', 'ads-twitter.com', 'x.com'], vendor: 'X', product: 'X (Twitter) Pixel', category: 'advertising' },
  { domains: ['snapchat.com', 'sc-static.net'], vendor: 'Snap', product: 'Snap Pixel', category: 'advertising' },
  { domains: ['pinterest.com', 'pinimg.com'], vendor: 'Pinterest', product: 'Pinterest Tag', category: 'advertising' },
  { domains: ['amazon-adsystem.com'], vendor: 'Amazon', product: 'Amazon Ads', category: 'advertising' },
  { domains: ['adsrvr.org'], vendor: 'The Trade Desk', product: 'The Trade Desk', category: 'advertising' },
  { domains: ['outbrain.com'], vendor: 'Outbrain', product: 'Outbrain Pixel', category: 'advertising' },
  { domains: ['adnxs.com'], vendor: 'Microsoft', product: 'Xandr', category: 'advertising' },
  { domains: ['rubiconproject.com'], vendor: 'Magnite', product: 'Rubicon', category: 'advertising' },
  { domains: ['pubmatic.com'], vendor: 'PubMatic', product: 'PubMatic', category: 'advertising' },
  { domains: ['inmobi.com'], vendor: 'InMobi', product: 'InMobi', category: 'advertising' },
  { domains: ['affle.com', 'mcanvas.com'], vendor: 'Affle', product: 'Affle', category: 'advertising' },
  { domains: ['vizury.com'], vendor: 'Affle', product: 'Vizury', category: 'advertising' },
  { domains: ['mixpanel.com'], vendor: 'Mixpanel', product: 'Mixpanel', category: 'analytics' },
  { domains: ['amplitude.com'], vendor: 'Amplitude', product: 'Amplitude', category: 'analytics' },
  { domains: ['segment.io', 'segment.com'], vendor: 'Twilio', product: 'Segment', category: 'analytics' },
  { domains: ['rudderstack.com', 'rudderlabs.com'], vendor: 'RudderStack', product: 'RudderStack', category: 'analytics' },
  { domains: ['heapanalytics.com', 'heap.io'], vendor: 'Heap', product: 'Heap', category: 'analytics' },
  { domains: ['posthog.com'], vendor: 'PostHog', product: 'PostHog', category: 'analytics' },
  { domains: ['adobedc.net', 'omtrdc.net', 'demdex.net', '2o7.net'], vendor: 'Adobe', product: 'Adobe Experience Cloud', category: 'analytics' },
  { domains: ['scorecardresearch.com'], vendor: 'Comscore', product: 'Comscore', category: 'analytics' },
  { domains: ['newrelic.com', 'nr-data.net'], vendor: 'New Relic', product: 'New Relic Browser', category: 'analytics' },
  { domains: ['sentry.io'], vendor: 'Sentry', product: 'Sentry', category: 'other' },
  { domains: ['fullstory.com'], vendor: 'FullStory', product: 'FullStory', category: 'session-replay' },
  { domains: ['logrocket.com', 'lr-ingest.io', 'lr-in.com'], vendor: 'LogRocket', product: 'LogRocket', category: 'session-replay' },
  { domains: ['smartlook.com'], vendor: 'Smartlook', product: 'Smartlook', category: 'session-replay' },
  { domains: ['mouseflow.com'], vendor: 'Mouseflow', product: 'Mouseflow', category: 'session-replay' },
  { domains: ['adjust.com', 'adj.st'], vendor: 'Adjust', product: 'Adjust', category: 'attribution' },
  { domains: ['singular.net'], vendor: 'Singular', product: 'Singular', category: 'attribution' },
  { domains: ['kochava.com'], vendor: 'Kochava', product: 'Kochava', category: 'attribution' },
  { domains: ['onesignal.com'], vendor: 'OneSignal', product: 'OneSignal', category: 'customer-engagement' },
  { domains: ['braze.com', 'appboy.com'], vendor: 'Braze', product: 'Braze', category: 'customer-engagement' },
  { domains: ['intercom.io', 'intercomcdn.com'], vendor: 'Intercom', product: 'Intercom', category: 'customer-engagement' },
  { domains: ['freshchat.com', 'freshworks.com', 'freshdesk.com'], vendor: 'Freshworks', product: 'Freshworks', category: 'customer-engagement' },
  { domains: ['zopim.com', 'zdassets.com', 'zendesk.com'], vendor: 'Zendesk', product: 'Zendesk', category: 'customer-engagement' },
  { domains: ['truecaller.com'], vendor: 'Truecaller', product: 'Truecaller', category: 'other' },
  // Google Analytics script files (analytics.js, ga.js): the hits themselves are decoded by the GA4 decoder.
  { domains: ['google-analytics.com'], vendor: 'Google', product: 'Google Analytics 4', category: 'analytics' },
  { domains: ['gstatic.com', 'googleapis.com', 'google.com', 'google.co.in', 'googleusercontent.com'], vendor: 'Google', product: 'Google services', category: 'other' },
  { domains: ['youtube.com', 'ytimg.com'], vendor: 'Google', product: 'YouTube', category: 'other' },
  { domains: ['facebook.com', 'fbcdn.net', 'instagram.com'], vendor: 'Meta', product: 'Meta', category: 'advertising' },
];
