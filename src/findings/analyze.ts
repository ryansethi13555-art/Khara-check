import { formsFor, type CanaryForm } from '../canary/forms.js';
import { scanSurface, type Surface } from '../canary/matcher.js';
import { protobufToJson } from '../canary/protobuf.js';
import { decodeBytes } from '../canary/unfold.js';
import { identify } from '../decoders/index.js';
import type {
  Analysis,
  Canary,
  ContactedParty,
  Finding,
  PostData,
  Recipient,
  RequestRecord,
  RunInfo,
  Sighting,
} from '../types.js';
import { hostMatches, hostOf, registrableDomain } from '../util/domains.js';

/** Headers that cannot carry typed data, or that only repeat the URL. */
const SKIP_HEADERS = /^(:|sec-|accept|user-agent$|content-type$|content-length$|host$|connection$|origin$|upgrade-insecure-requests$|pragma$|cache-control$|if-|range$|dnt$|priority$)/;

const STRENGTH: Record<Sighting['formKind'], number> = { plain: 0, encoded: 1, hash: 2 };

function bodySurface(postData: PostData, surface: Surface['surface']): Surface | null {
  if (postData.encoding === 'utf8') return { surface, text: postData.text };
  const bytes = Buffer.from(postData.text, 'base64');
  const decoded = decodeBytes(bytes);
  if (decoded) return { surface, text: decoded.text, preSteps: decoded.gunzipped ? [decoded.how] : [] };
  const proto = protobufToJson(bytes);
  if (proto) return { surface, text: proto, preSteps: ['read as protobuf (no schema)'] };
  // Binary we cannot interpret: still scan it byte for byte, so plain values are not missed.
  return { surface, text: bytes.toString('latin1'), preSteps: ['read as raw bytes'] };
}

function surfacesOf(record: RequestRecord): Surface[] {
  const out: Surface[] = [{ surface: 'url', text: record.url }];
  for (const name of Object.keys(record.requestHeaders).sort()) {
    if (SKIP_HEADERS.test(name)) continue;
    out.push({ surface: 'header', surfaceName: name, text: record.requestHeaders[name]! });
  }
  if (record.postData) {
    const body = bodySurface(record.postData, 'body');
    if (body) out.push(body);
  }
  for (const frame of record.framesSent ?? []) {
    const body = bodySurface(frame.postData, 'websocket');
    if (body) out.push(body);
  }
  return out;
}

function headerMeaning(name: string): string | undefined {
  if (name === 'referer') {
    return 'the Referer header: the browser was told to pass on the full address of the page, and that address contains it';
  }
  if (name === 'cookie') return 'a cookie sent with the request';
  return undefined;
}

/** Consent state at a moment of the run, from the recorded consent steps. */
function consentAt(run: RunInfo, wallTime: number): Finding['consent'] {
  if (!run.consent) return undefined;
  let state: Finding['consent'] = 'before-choice';
  for (const s of run.steps) {
    if (s.startedAt > wallTime) break;
    if (s.action === 'consent-reject') state = 'after-reject';
    if (s.action === 'consent-accept') state = 'after-accept';
  }
  return state;
}

/**
 * Turns a raw capture into findings. This is a pure function of the evidence:
 * the same bundle always produces the same analysis, with no browser and no network.
 */
export function analyze(run: RunInfo, canaries: Canary[], records: RequestRecord[]): Analysis {
  const forms: CanaryForm[] = canaries.flatMap(formsFor);
  const canaryByName = new Map(canaries.map((c) => [c.name, c]));
  const siteHost = hostOf(run.site.origin);
  const isFirstParty = (host: string): boolean =>
    host === siteHost || run.site.firstPartyDomains.some((d) => hostMatches(host, d));

  const leaks: Finding[] = [];
  const firstParty: Finding[] = [];
  const contacted = new Map<string, ContactedParty>();
  let thirdPartyRequests = 0;

  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const host = hostOf(record.url);
    if (!host) continue;
    const party: Recipient['party'] = isFirstParty(host) ? 'first' : 'third';
    const identified = party === 'third' ? identify(record) : undefined;
    const recipient: Recipient = {
      host,
      domain: registrableDomain(host),
      party,
      ...(identified ? { vendor: identified.vendor, product: identified.product, category: identified.category } : {}),
    };
    const partyKey = recipient.product ?? recipient.domain;

    if (party === 'third') {
      thirdPartyRequests++;
      const existing = contacted.get(partyKey);
      if (existing) existing.requests++;
      else contacted.set(partyKey, { recipient, requests: 1, firstRequestId: record.id, receivedCanary: false });
    }

    const sightings = surfacesOf(record)
      .flatMap((surface) => scanSurface(surface, forms))
      .map((s) => {
        const meaning =
          s.surface === 'header' ? headerMeaning(s.surfaceName ?? '') : identified?.decoder?.meaning?.(s.field, s.surface);
        return meaning ? { ...s, meaning } : s;
      });
    if (!sightings.length) continue;

    const step = run.steps[record.step];
    const consent = consentAt(run, record.wallTime);
    for (const canaryName of [...new Set(sightings.map((s) => s.canary))]) {
      const mine = sightings
        .filter((s) => s.canary === canaryName)
        .sort((a, b) => STRENGTH[a.formKind] - STRENGTH[b.formKind] || (a.exactness === 'full' ? 0 : 1) - (b.exactness === 'full' ? 0 : 1));
      const finding: Finding = {
        id: '',
        canary: canaryName,
        recipient,
        requestId: record.id,
        requestSeq: record.seq,
        method: record.method,
        wallTime: record.wallTime,
        step: record.step,
        msAfterStep: step ? Math.max(0, record.wallTime - step.startedAt) : 0,
        sightings: mine,
        strongest: mine[0]!.formKind,
        ...(identified?.call ? { decoded: identified.call } : {}),
        ...(record.initiator ? { initiator: record.initiator } : {}),
        delivery:
          record.sandbox === 'answered-locally' ? 'sandboxed' : record.response && !record.failure ? 'delivered' : 'attempted',
        ...(record.response ? { responseStatus: record.response.status } : {}),
        ...(record.response?.remoteAddress ? { remoteAddress: record.response.remoteAddress } : {}),
        confidence: canaryByName.get(canaryName)?.unique ? 'unique' : 'common',
        ...(consent ? { consent } : {}),
      };
      if (party === 'third') {
        leaks.push(finding);
        contacted.get(partyKey)!.receivedCanary = true;
      } else {
        firstParty.push(finding);
      }
    }
  }

  leaks.forEach((f, i) => (f.id = `L${String(i + 1).padStart(2, '0')}`));
  firstParty.forEach((f, i) => (f.id = `S${String(i + 1).padStart(2, '0')}`));

  const contactedList = [...contacted.values()].sort(
    (a, b) => Number(b.receivedCanary) - Number(a.receivedCanary) || a.recipient.domain.localeCompare(b.recipient.domain),
  );
  return {
    schema: 1,
    canaries,
    leaks,
    firstParty,
    contacted: contactedList,
    totals: {
      requests: records.length,
      thirdPartyRequests,
      thirdPartyDomains: new Set(contactedList.map((c) => c.recipient.domain)).size,
      leakingRecipients: contactedList.filter((c) => c.receivedCanary).length,
    },
  };
}
