/**
 * Behaviour added after the first field test on real Indian health sites (22 November 2026).
 * Each test reproduces, with invented data, a situation those sites showed.
 */
import { describe, expect, it } from 'vitest';
import { formsFor } from '../../src/canary/forms.js';
import { generateCanary } from '../../src/canary/generate.js';
import { scanSurface } from '../../src/canary/matcher.js';
import { identify } from '../../src/decoders/index.js';
import { analyze } from '../../src/findings/analyze.js';
import { buildModel } from '../../src/report/model.js';
import type { Canary, RequestRecord, RunInfo, StepRecord } from '../../src/types.js';
import { seededRng } from '../../src/util/random.js';

const opts = { rng: seededRng('field'), allowGeneratedPhone: true };
const common = (value: string): Canary => generateCanary('search', { type: 'search-term', value }, opts);
const found = (c: Canary, text: string): boolean => scanSurface({ surface: 'url', text }, formsFor(c)).length > 0;

let seq = 0;
function req(url: string, extra: Partial<RequestRecord> = {}): RequestRecord {
  seq++;
  return {
    id: `r${String(seq).padStart(4, '0')}`,
    seq,
    kind: 'http',
    source: 'cdp',
    method: 'GET',
    url,
    resourceType: 'xhr',
    wallTime: 1000 + seq,
    pageIndex: 0,
    requestHeaders: {},
    headersSource: 'wire',
    response: { status: 200, statusText: 'OK', headers: {} },
    step: 0,
    ...extra,
  };
}

function run(extra: Partial<RunInfo> = {}, steps?: StepRecord[]): RunInfo {
  return {
    tool: { name: 'khara-check', version: 'test' },
    journeyName: 'test',
    site: { name: 'Pharmacy', origin: 'https://www.pharmacy.example', firstPartyDomains: ['pharmacy.example'] },
    mode: 'live',
    capture: 'automated',
    startedAt: 1000,
    endedAt: 2000,
    environment: { node: '', platform: '', playwright: '', browser: '', browserVersion: '', userAgent: '', viewport: { width: 1, height: 1 }, locale: 'en-IN', timezone: 'Asia/Kolkata', headless: true },
    steps: steps ?? [{ index: 0, action: 'type', label: 'Searched', startedAt: 1000, endedAt: 1001, pageUrl: '', ok: true }],
    notes: [],
    ...extra,
  } as RunInfo;
}

describe('common search words', () => {
  it('finds a short word like "HIV" only when it stands as a whole word', () => {
    const hiv = common('HIV');
    expect(found(hiv, 'https://www.google.com/rmkt/collect/1/?data=event%3Dsearch%3Bsearch_term%3DHIV')).toBe(true);
    expect(found(hiv, 'https://t.example/c?q=hiv+test')).toBe(true);
    expect(found(hiv, 'https://t.example/c?token=AQxhiVq7Lw')).toBe(false);
    expect(found(hiv, 'https://t.example/archive/page')).toBe(false);
  });

  it('does not count a common word that is part of a test page name, but does count it standing alone', () => {
    const hiv = common('HIV');
    expect(found(hiv, 'https://www.lab.example/delhi/tests/hiv-1-2-antibody-test')).toBe(false);
    expect(found(hiv, 'https://t.example/c?u=/package/gurgaon/hiv-screening-package')).toBe(false);
    expect(found(hiv, 'https://t.example/c?dl=' + encodeURIComponent('https://www.lab.example/search?q=HIV'))).toBe(true);
    // A page title still holds the bare word: a common value cannot tell typed text from page text.
    expect(found(hiv, 'https://t.example/c?og_title=' + encodeURIComponent('HIV 1 & 2 Antibody Test'))).toBe(true);
  });

  it('does not match a common term joined into a product file name', () => {
    const kit = common('pregnancy test kit');
    expect(found(kit, 'https://cdn.example/images/prega_news_pregnancy_test_kit_1.jpg')).toBe(false);
    expect(found(kit, 'https://t.example/c?q=pregnancy+test+kit')).toBe(true);
    expect(found(kit, 'https://t.example/c?dl=' + encodeURIComponent('https://shop.example/search?name=pregnancy test kit'))).toBe(true);
  });

  it('still finds a common term inside a base64 page path', () => {
    const term = common('sertraline');
    const path = Buffer.from('A::sertraline').toString('base64');
    expect(found(term, `https://www.google.com/pagead/1p-user-list/1/?url=${encodeURIComponent('https://shop.example/searchAll/' + path)}`)).toBe(true);
  });
});

describe('collectors behind the site\'s own address', () => {
  const search = generateCanary('search', { type: 'search-term', base: 'sertraline' }, opts);
  const rudder = (): RequestRecord =>
    req('https://rudderapi.pharmacy.example/v1/track', {
      method: 'POST',
      requestHeaders: { anonymousid: 'abc', authorization: 'Basic xyz' },
      postData: { encoding: 'utf8', text: JSON.stringify({ event: 'Search', properties: { searched_term: search.value } }), bytes: 1, sha256: '' },
    });

  it('counts a site-looking hostname that DNS shows is an alias for a tracking service as that service', () => {
    const a = analyze(run({ dns: { 'rudderapi.pharmacy.example': ['pharmacy.dataplane.rudderstack.com'] } }), [search], [rudder()]);
    expect(a.leaks).toHaveLength(1);
    expect(a.leaks[0]!.recipient.vendor).toBe('RudderStack');
    expect(a.leaks[0]!.recipient.aliasOf).toBe('pharmacy.dataplane.rudderstack.com');
    expect(a.firstParty).toHaveLength(0);
  });

  it('ignores aliases for hosting companies', () => {
    const a = analyze(run({ dns: { 'www.pharmacy.example': ['d123.cloudfront.net'] } }), [search], [req(`https://www.pharmacy.example/search?q=${encodeURIComponent(search.value)}`)]);
    expect(a.leaks).toHaveLength(0);
    expect(a.firstParty).toHaveLength(1);
  });

  it('without DNS, flags the collector shape at the site\'s own address, and the headline says so', () => {
    const r = run();
    const a = analyze(r, [search], [rudder()]);
    expect(a.leaks).toHaveLength(0);
    expect(a.firstParty[0]!.recipient.collector?.vendor).toBe('RudderStack');
    const m = buildModel(r, a, 'seal');
    expect(m.headline).toMatch(/data collector at the site's own address/);
    expect(m.collectors[0]!.host).toBe('rudderapi.pharmacy.example');
  });
});

describe('report honesty', () => {
  const search = generateCanary('search', { type: 'search-term', base: 'sertraline' }, opts);
  const page = `https://www.pharmacy.example/search?q=${encodeURIComponent(search.value)}`;

  it('puts companies reached only through the Referer header in their own tier', () => {
    const r = run();
    const a = analyze(r, [search], [
      req(`https://analytics.google.com/g/collect?v=2&tid=G-1&en=page_view&dl=${encodeURIComponent(page)}`),
      req('https://cdn.vendor-sample.example/lib.js', { requestHeaders: { referer: page } }),
    ]);
    const m = buildModel(r, a, 'seal');
    expect(m.headline).toBe('1 company was sent what the customer typed.');
    expect(m.refererOnly).toEqual(['vendor-sample.example']);
    expect(m.subhead).toMatch(/only in the page address the browser passes on/);
  });

  it('counts Referer-only services by service, so a second Google product is not dropped from the count', () => {
    const r = run();
    const a = analyze(r, [search], [
      req(`https://analytics.google.com/g/collect?v=2&tid=G-1&en=page_view&dl=${encodeURIComponent(page)}`),
      req('https://www.googletagmanager.com/gtm.js?id=GTM-1', { requestHeaders: { referer: page } }),
      req('https://cdn.vendor-sample.example/lib.js', { requestHeaders: { referer: page } }),
    ]);
    const m = buildModel(r, a, 'seal');
    expect(m.refererOnly).toHaveLength(2);
    expect(m.subhead).toMatch(/ 2 more services \(/);
  });

  it('does not count a domain carrying the site\'s own name, and says how to declare it', () => {
    const r = run();
    const a = analyze(r, [search], [
      req(`https://analytics.google.com/g/collect?v=2&tid=G-1&en=page_view&dl=${encodeURIComponent(page)}`),
      req(`https://apigateway.pharmacy247.example/search?query=${encodeURIComponent(search.value)}`),
    ]);
    const m = buildModel(r, a, 'seal');
    expect(m.headline).toBe('1 company was sent what the customer typed.');
    expect(m.lookalikes).toEqual(['pharmacy247.example']);
    expect(m.subhead).toMatch(/may belong to the same owner/);
  });

  it('says a blocked run proves nothing, instead of reading as clean', () => {
    const steps: StepRecord[] = [{ index: 0, action: 'goto', label: 'Opened the home page', startedAt: 1000, endedAt: 1001, pageUrl: '', ok: true }];
    const r = run({ handoffs: [{ index: 0, action: 'handoff', label: 'The site showed a bot check (Access denied page)', startedAt: 1002, endedAt: 1003, pageUrl: '', ok: false, actor: 'person' }] }, steps);
    const m = buildModel(r, analyze(r, [search], [req('https://www.pharmacy.example/')]), 'seal');
    expect(m.headline).toBe('This run stopped early, so it does not show what the site does.');
    expect(m.stopped?.reason).toMatch(/bot check/);
  });

  it('writes a readable sentence for a company it does not recognise', () => {
    const r = run();
    const m = buildModel(r, analyze(r, [search], [req(`https://px.unknown-sample.example/p.gif?u=${encodeURIComponent(page)}`)]), 'seal');
    expect(m.groups[0]!.sentence).toMatch(/was sent as readable text to px\.unknown-sample\.example \(a company Khara Check does not recognise\), [\d.]+ seconds after/);
  });

  it('names Google Ads remarketing and conversion endpoints as Google Ads', () => {
    for (const path of ['/rmkt/collect/123/?data=x', '/measurement/conversion/?x=1', '/measurement/1p-conversion/?x=1']) {
      expect(identify(req(`https://www.google.com${path}`))?.product).toBe('Google Ads');
    }
    expect(identify(req('https://www.google-analytics.com/analytics.js'))?.product).toBe('Google Analytics 4');
  });
});
