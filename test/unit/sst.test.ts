/**
 * Google server-side tagging detection, after Moti et al., "The Bitter Pill" (section 3.4).
 * All hosts, IDs and values are invented.
 */
import { describe, expect, it } from 'vitest';
import { generateCanary } from '../../src/canary/generate.js';
import { collectorShape } from '../../src/decoders/index.js';
import { analyze } from '../../src/findings/analyze.js';
import { detectServerSideTagging, hasGoogleTagShape } from '../../src/findings/sst.js';
import { renderReports } from '../../src/report/index.js';
import type { RequestRecord, RunInfo } from '../../src/types.js';
import { seededRng } from '../../src/util/random.js';

/** The URL parameters of a real GA4 page_view hit from gtag.js, with invented values. */
const GA4_QUERY =
  'v=2&tid=G-TEST12345&gtm=45je5bc0v9&_p=1794554171341&gcd=13l3l3l3l1l1&npa=0&dma=0&tag_exp=101509157&cid=111.222' +
  '&ul=en-in&sr=1280x800&uaa=x86&uab=64&uafvl=Chromium&uamb=0&uam=&uap=Linux&uapv=6.8&uaw=0&frm=0&pscdl=noapi' +
  '&_eu=AAAAAAQ&_s=1&sid=1794554171&sct=1&seg=0&dl=https%3A%2F%2Fwww.pharmacy.example%2F&dt=Pharmacy&en=page_view&tfd=812&rcb=1';

let seq = 0;
function req(url: string, extra: Partial<RequestRecord> = {}): RequestRecord {
  seq++;
  return {
    id: `r${String(seq).padStart(4, '0')}`,
    seq,
    kind: 'http',
    source: 'cdp',
    method: 'POST',
    url,
    resourceType: 'ping',
    wallTime: 1000 + seq,
    pageIndex: 0,
    requestHeaders: {},
    headersSource: 'wire',
    response: { status: 204, statusText: 'No Content', headers: {} },
    step: 0,
    ...extra,
  };
}

function run(extra: Partial<RunInfo> = {}): RunInfo {
  return {
    tool: { name: 'khara-check', version: 'test' },
    journeyName: 'test',
    site: { name: 'Pharmacy', origin: 'https://www.pharmacy.example', firstPartyDomains: [] },
    mode: 'live',
    capture: 'automated',
    startedAt: 1000,
    endedAt: 2000,
    environment: { node: '', platform: '', playwright: '', browser: '', browserVersion: '', userAgent: '', viewport: { width: 1, height: 1 }, locale: 'en-IN', timezone: 'Asia/Kolkata', headless: true },
    steps: [{ index: 0, action: 'goto', label: 'Opened the home page', startedAt: 1000, endedAt: 1001, pageUrl: '', ok: true }],
    notes: [],
    ...extra,
  } as RunInfo;
}

const gtmInitiator = (script: string): RequestRecord['initiator'] => ({ type: 'script', url: script, stack: [script] });

describe('the Google tag parameter fingerprint', () => {
  it('recognises a GA4 hit by its parameters, whatever the path', () => {
    expect(hasGoogleTagShape(req(`https://sgtm.pharmacy.example/g/collect?${GA4_QUERY}`))).toBe(true);
    // Two of the paper's Italian sites used random paths starting with "ngt".
    expect(hasGoogleTagShape(req(`https://sgtm.pharmacy.example/ngtwyxyzwjg?${GA4_QUERY}`))).toBe(true);
  });

  it('needs v=2, a G- measurement ID and enough of the usual parameters', () => {
    expect(hasGoogleTagShape(req('https://www.pharmacy.example/api?v=2&tid=G-TEST12345&cid=1&dl=x&dt=y'))).toBe(false);
    expect(hasGoogleTagShape(req(`https://www.pharmacy.example/x?${GA4_QUERY.replace('v=2', 'v=1')}`))).toBe(false);
    expect(hasGoogleTagShape(req(`https://www.pharmacy.example/x?${GA4_QUERY.replace('tid=G-TEST12345', 'tid=UA-1-1')}`))).toBe(false);
  });
});

describe('detecting server-side tagging endpoints', () => {
  it('ignores ordinary client-side tagging, sent straight to Google', () => {
    const records = [
      req(`https://region1.google-analytics.com/g/collect?${GA4_QUERY}`),
      req(`https://analytics.google.com/g/collect?${GA4_QUERY}`),
      req(`https://stats.g.doubleclick.net/g/collect?${GA4_QUERY}`),
      req(`https://www.google.co.in/g/collect?${GA4_QUERY}`),
    ];
    expect(detectServerSideTagging(run(), records)).toEqual([]);
  });

  it('flags a first-party endpoint and confirms it with the initiator and the hosting', () => {
    const records = [
      req(`https://sgtm.pharmacy.example/g/collect?${GA4_QUERY}`, {
        initiator: gtmInitiator('https://sgtm.pharmacy.example/gtm.js?id=GTM-TEST99'),
        response: { status: 204, statusText: 'No Content', headers: { server: 'Google Frontend' }, remoteAddress: '203.0.113.7:443' },
      }),
      req(`https://sgtm.pharmacy.example/g/collect?${GA4_QUERY.replace('en=page_view', 'en=view_item')}`, {
        initiator: gtmInitiator('https://sgtm.pharmacy.example/gtm.js?id=GTM-TEST99'),
      }),
    ];
    const [e, ...more] = detectServerSideTagging(run({ dns: { 'sgtm.pharmacy.example': ['pharmacy-sgtm-abc123.a.run.app'] } }), records);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      host: 'sgtm.pharmacy.example',
      party: 'first',
      paths: ['/g/collect'],
      measurementIds: ['G-TEST12345'],
      requests: 2,
      selfHostedTagScripts: ['https://sgtm.pharmacy.example/gtm.js?id=GTM-TEST99'],
      addresses: ['203.0.113.7'],
      confidence: 'confirmed',
    });
    expect(e!.tagParams.length).toBe(30);
    expect(e!.hosting).toEqual(['Google Cloud (Server: Google Frontend)', 'Google Cloud Run (DNS alias pharmacy-sgtm-abc123.a.run.app)']);
  });

  it('marks an endpoint with no second sign as likely, not confirmed', () => {
    const [e] = detectServerSideTagging(run(), [req(`https://data.pharmacy.example/ngtmapwbued?${GA4_QUERY}`)]);
    expect(e).toMatchObject({ host: 'data.pharmacy.example', confidence: 'likely', tagScripts: [] });
  });

  it('counts a Google tag script loaded from Google as confirmation too', () => {
    const [e] = detectServerSideTagging(run(), [
      req(`https://metrics.pharmacy.example/g/collect?${GA4_QUERY}`, {
        initiator: gtmInitiator('https://www.googletagmanager.com/gtag/js?id=G-TEST12345'),
      }),
    ]);
    expect(e).toMatchObject({ confidence: 'confirmed', selfHostedTagScripts: [] });
  });

  it('reads parameters sent in a batched body', () => {
    const [shared, ...rest] = GA4_QUERY.split('&en=');
    const body = `en=${rest.join('&en=')}`;
    const [e] = detectServerSideTagging(run(), [
      req(`https://sst.pharmacy.example/g/collect?${shared}`, { postData: { encoding: 'utf8', text: body, bytes: body.length, sha256: '' } }),
    ]);
    expect(e?.tagParams).toContain('tfd');
  });

  it('flags a host that is neither the site nor Google as "other"', () => {
    const [e] = detectServerSideTagging(run(), [req(`https://collect.tagging-vendor.example/g/collect?${GA4_QUERY}`)]);
    expect(e).toMatchObject({ party: 'other' });
  });
});

describe('server-side tagging in the analysis and the report', () => {
  const records = [
    req(`https://sgtm.pharmacy.example/ngtwyxyzwjg?${GA4_QUERY}`, {
      initiator: gtmInitiator('https://www.googletagmanager.com/gtm.js?id=GTM-TEST99'),
    }),
  ];
  const canary = generateCanary('search', { type: 'search-term', value: 'metformin' }, { rng: seededRng('sst'), allowGeneratedPhone: true });

  it('treats a random-path endpoint as a collector at the site\'s own address', () => {
    expect(collectorShape(records[0]!)).toEqual({ vendor: 'Google', product: 'Google Analytics 4 (server-side tagging)' });
  });

  it('lists endpoints in the analysis only when there are some', () => {
    expect(analyze(run(), [canary], records).serverSideTagging?.map((e) => e.host)).toEqual(['sgtm.pharmacy.example']);
    expect('serverSideTagging' in analyze(run(), [canary], [req('https://www.pharmacy.example/')])).toBe(false);
  });

  it('explains it in the reports and cites the paper', () => {
    const r = run();
    const { html, markdown } = renderReports(r, analyze(r, [canary], records), records, 'seal');
    for (const text of [html, markdown]) {
      expect(text).toContain('Server-side tagging');
      expect(text).toContain('The Bitter Pill');
      expect(text).toContain('sgtm.pharmacy.example');
    }
  });
});
