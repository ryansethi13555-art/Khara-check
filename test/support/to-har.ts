import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeRequestLog } from '../../src/evidence/bundle.js';
import type { RunInfo } from '../../src/types.js';

/** Turns a Khara Check evidence folder into the HAR file Chrome DevTools would have saved, for import tests. */
export function bundleToHar(dir: string): string {
  const run = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as RunInfo;
  const { records } = decodeRequestLog(readFileSync(path.join(dir, 'capture/requests.jsonl'), 'utf8'));
  const docs = records.filter((r) => r.resourceType === 'document');
  const pages = docs.map((d, i) => ({ id: `page_${i + 1}`, startedDateTime: new Date(d.wallTime).toISOString(), title: d.url, pageTimings: {} }));
  const pageOf = (t: number): string | undefined => {
    let id: string | undefined;
    docs.forEach((d, i) => { if (d.wallTime <= t) id = `page_${i + 1}`; });
    return id;
  };
  const hdrs = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
  return JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'WebInspector', version: '537.36' },
      pages,
      entries: records.filter((r) => r.kind === 'http').map((r) => ({
        ...(pageOf(r.wallTime) ? { pageref: pageOf(r.wallTime) } : {}),
        startedDateTime: new Date(r.wallTime).toISOString(),
        _resourceType: r.resourceType,
        ...(r.initiator ? { _initiator: { type: r.initiator.type, url: r.initiator.url, stack: { callFrames: (r.initiator.stack ?? []).map((url) => ({ url })) } } } : {}),
        request: {
          method: r.method,
          url: r.url,
          httpVersion: 'http/2.0',
          headers: hdrs(r.requestHeaders),
          ...(r.postData ? { postData: { mimeType: r.requestHeaders['content-type'] ?? '', text: r.postData.text, ...(r.postData.encoding === 'base64' ? { _encoding: 'base64' } : {}) } } : {}),
        },
        response: r.response
          ? { status: r.response.status, statusText: r.response.statusText, httpVersion: 'http/2.0', headers: hdrs(r.response.headers), content: { mimeType: r.response.mimeType ?? '' } }
          : { status: 0, statusText: '', headers: [], content: {}, _error: r.failure ?? 'net::ERR_FAILED' },
      })),
    },
    _site: run.site.origin,
  });
}
