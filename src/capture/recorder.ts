import type { BrowserContext, Frame, Page, Request as PwRequest } from 'playwright';

/** The two things the recorder needs from a DevTools Protocol session, whoever provides it. */
export interface CdpSessionLike {
  on(event: string, handler: (params: any) => void): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  detach?(): Promise<void>;
}
type CDPSession = CdpSessionLike;
import type { Initiator, PostData, RequestRecord } from '../types.js';
import { sha256Hex } from '../util/hash.js';

/** A record while it is still being assembled. */
type Draft = Omit<RequestRecord, 'id' | 'seq'> & { _cdpId?: string; _session?: CDPSession; _needsBody?: boolean };

const NETWORK_SCHEME = /^(https?|wss?):/i;

export function toPostData(bytes: Uint8Array): PostData {
  const buf = Buffer.from(bytes);
  const sha256 = sha256Hex(buf);
  let text: string | null = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = null;
  }
  return text !== null
    ? { encoding: 'utf8', text, bytes: buf.length, sha256 }
    : { encoding: 'base64', text: buf.toString('base64'), bytes: buf.length, sha256 };
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

function toInitiator(raw: any): Initiator | undefined {
  if (!raw) return undefined;
  const stack: string[] = [];
  for (let s = raw.stack; s; s = s.parent) {
    for (const frame of s.callFrames ?? []) {
      if (frame.url && !stack.includes(frame.url)) stack.push(frame.url);
      if (stack.length >= 8) break;
    }
  }
  const top = raw.stack?.callFrames?.[0];
  const url: string | undefined = raw.url ?? top?.url;
  return {
    type: String(raw.type ?? 'other'),
    ...(url ? { url } : {}),
    ...(typeof (raw.lineNumber ?? top?.lineNumber) === 'number' ? { lineNumber: raw.lineNumber ?? top.lineNumber } : {}),
    ...(stack.length ? { stack } : {}),
  };
}

/**
 * Records every request the browser makes, from two independent vantage points:
 *
 *  1. The Chrome DevTools Protocol network log of each page and each cross-site frame.
 *     This is the primary record: exact wire headers, bodies (including sendBeacon and
 *     keepalive fetch), WebSocket frames, timings and the script that started each request.
 *  2. Playwright's own request events for the whole browser context. Anything seen here
 *     but missing from (1) is added, flagged with its source, so nothing is silently lost.
 */
export class Recorder {
  private drafts: Draft[] = [];
  private byCdpId = new Map<string, Draft>();
  private pendingWire = new Map<string, Record<string, string>[]>();
  private pendingSetCookies = new Map<string, string[][]>();
  private pwSeen: { request: PwRequest; wallTime: number; step: number; pageIndex: number }[] = [];
  private sessions: CDPSession[] = [];
  private attachedFrames = new WeakSet<Frame>();
  private pages: Page[] = [];
  private attaching = new Map<Page, Promise<void>>();
  private lastActivity = Date.now();
  private work: Promise<unknown>[] = [];
  /** Index of the journey step that is running. Set by the runner. */
  currentStep = -1;

  constructor(private readonly context?: BrowserContext) {
    if (!context) return;
    context.on('request', (request) => {
      if (!NETWORK_SCHEME.test(request.url())) return;
      this.lastActivity = Date.now();
      let pageIndex = 0;
      try {
        const page = request.frame().page();
        pageIndex = Math.max(0, this.pages.indexOf(page));
      } catch {
        /* service worker requests have no frame */
      }
      this.pwSeen.push({ request, wallTime: Date.now(), step: this.currentStep, pageIndex });
    });
    context.on('page', (page) => void this.attachPage(page));
  }

  /** Attach to a page. Await this for the first page before navigating, so nothing is missed. */
  attachPage(page: Page): Promise<void> {
    let attaching = this.attaching.get(page);
    if (!attaching) {
      this.pages.push(page);
      const pageIndex = this.pages.length - 1;
      attaching = this.attach(page, pageIndex);
      this.attaching.set(page, attaching);
      // Cross-site iframes live in their own process and need their own session.
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() || this.attachedFrames.has(frame)) return;
        this.attachedFrames.add(frame);
        void this.attach(frame, pageIndex);
      });
    }
    return attaching;
  }

  private async attach(target: Page | Frame, pageIndex: number): Promise<void> {
    let session: CDPSession;
    try {
      session = await this.context!.newCDPSession(target as Page);
    } catch {
      return; // same-process frame: already covered by its page's session
    }
    await this.tap(session, pageIndex);
  }

  /**
   * Listens to one DevTools Protocol session. Only the Network domain is enabled:
   * nothing runs inside the page, and the page cannot tell it is being recorded
   * any more than it can tell when its own developer tools are open on the Network tab.
   */
  async tap(session: CdpSessionLike, pageIndex: number, opts: { enable?: boolean } = {}): Promise<void> {
    this.sessions.push(session);
    let clockOffset: number | null = null; // wall clock seconds minus monotonic seconds
    const wall = (monotonic: number, wallTime?: number): number => {
      if (clockOffset === null && wallTime !== undefined) clockOffset = wallTime - monotonic;
      return Math.round(((clockOffset ?? Date.now() / 1000 - monotonic) + monotonic) * 1000);
    };

    session.on('Network.requestWillBeSent', (e: any) => {
      if (!NETWORK_SCHEME.test(e.request.url)) return;
      this.lastActivity = Date.now();
      const previous = this.byCdpId.get(e.requestId);
      if (previous && e.redirectResponse) {
        previous.response = {
          status: e.redirectResponse.status,
          statusText: e.redirectResponse.statusText ?? '',
          headers: lowerKeys(e.redirectResponse.headers),
          ...(e.redirectResponse.remoteIPAddress
            ? { remoteAddress: `${e.redirectResponse.remoteIPAddress}:${e.redirectResponse.remotePort}` }
            : {}),
        };
      }
      const draft: Draft = {
        kind: 'http',
        source: 'cdp',
        method: e.request.method,
        url: e.request.url + (e.request.urlFragment ?? ''),
        resourceType: String(e.type ?? 'Other'),
        wallTime: wall(e.timestamp, e.wallTime),
        ...(e.documentURL ? { documentUrl: e.documentURL } : {}),
        ...(e.frameId ? { frameId: e.frameId } : {}),
        pageIndex,
        requestHeaders: lowerKeys(e.request.headers),
        headersSource: 'provisional',
        ...(toInitiator(e.initiator) ? { initiator: toInitiator(e.initiator)! } : {}),
        step: this.currentStep,
        _cdpId: e.requestId,
        _session: session,
      };
      if (previous && e.redirectResponse) (draft as any)._redirectedFromDraft = previous;

      const entries: { bytes?: string }[] | undefined = e.request.postDataEntries;
      if (entries?.length && entries.every((x) => typeof x.bytes === 'string')) {
        draft.postData = toPostData(Buffer.concat(entries.map((x) => Buffer.from(x.bytes!, 'base64'))));
      } else if (typeof e.request.postData === 'string') {
        draft.postData = toPostData(Buffer.from(e.request.postData, 'utf8'));
      } else if (e.request.hasPostData) {
        draft._needsBody = true;
        this.work.push(this.fetchBody(draft));
      }

      this.drafts.push(draft);
      this.byCdpId.set(e.requestId, draft);
      const wire = this.pendingWire.get(e.requestId)?.shift();
      if (wire) this.applyWire(draft, wire);
    });

    session.on('Network.requestWillBeSentExtraInfo', (e: any) => {
      const headers = lowerKeys(e.headers);
      const draft = this.byCdpId.get(e.requestId);
      if (draft && draft.headersSource === 'provisional') this.applyWire(draft, headers);
      else this.pendingWire.set(e.requestId, [...(this.pendingWire.get(e.requestId) ?? []), headers]);
    });

    session.on('Network.responseReceived', (e: any) => {
      const draft = this.byCdpId.get(e.requestId);
      if (!draft) return;
      const r = e.response;
      draft.response = {
        status: r.status,
        statusText: r.statusText ?? '',
        headers: lowerKeys(r.headers),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        ...(r.remoteIPAddress ? { remoteAddress: `${r.remoteIPAddress}:${r.remotePort}` } : {}),
        ...(r.protocol ? { protocol: r.protocol } : {}),
      };
      const cookies = this.pendingSetCookies.get(e.requestId)?.shift();
      if (cookies?.length) draft.response.setCookies = cookies;
    });

    session.on('Network.responseReceivedExtraInfo', (e: any) => {
      const raw = lowerKeys(e.headers)['set-cookie'];
      const cookies = raw ? raw.split('\n').filter(Boolean) : [];
      const draft = this.byCdpId.get(e.requestId);
      if (draft?.response && !draft.response.setCookies) {
        if (cookies.length) draft.response.setCookies = cookies;
      } else {
        this.pendingSetCookies.set(e.requestId, [...(this.pendingSetCookies.get(e.requestId) ?? []), cookies]);
      }
    });

    session.on('Network.loadingFailed', (e: any) => {
      const draft = this.byCdpId.get(e.requestId);
      if (draft) draft.failure = e.blockedReason ? `${e.errorText} (${e.blockedReason})` : String(e.errorText);
    });

    // WebSockets.
    session.on('Network.webSocketCreated', (e: any) => {
      this.lastActivity = Date.now();
      const draft: Draft = {
        kind: 'websocket',
        source: 'cdp',
        method: 'GET',
        url: e.url,
        resourceType: 'WebSocket',
        wallTime: Date.now(),
        pageIndex,
        requestHeaders: {},
        headersSource: 'provisional',
        ...(toInitiator(e.initiator) ? { initiator: toInitiator(e.initiator)! } : {}),
        framesSent: [],
        step: this.currentStep,
        _cdpId: e.requestId,
      };
      this.drafts.push(draft);
      this.byCdpId.set(e.requestId, draft);
    });
    session.on('Network.webSocketWillSendHandshakeRequest', (e: any) => {
      const draft = this.byCdpId.get(e.requestId);
      if (!draft) return;
      draft.requestHeaders = lowerKeys(e.request?.headers);
      draft.headersSource = 'wire';
      draft.wallTime = wall(e.timestamp, e.wallTime);
    });
    session.on('Network.webSocketFrameSent', (e: any) => {
      this.lastActivity = Date.now();
      const draft = this.byCdpId.get(e.requestId);
      if (!draft) return;
      const payload: string = e.response?.payloadData ?? '';
      const bytes = e.response?.opcode === 2 ? Buffer.from(payload, 'base64') : Buffer.from(payload, 'utf8');
      draft.framesSent!.push({ wallTime: wall(e.timestamp), postData: toPostData(bytes) });
    });

    if (opts.enable !== false) await session.send('Network.enable', { maxPostDataSize: 16 * 1024 * 1024 });
  }

  /** Lets a caller (the attach mode) keep the idle timer honest. */
  touch(): void {
    this.lastActivity = Date.now();
  }

  private applyWire(draft: Draft, headers: Record<string, string>): void {
    // Wire headers are the truth. Keep provisional ones the wire set does not mention (rare).
    draft.requestHeaders = { ...draft.requestHeaders, ...headers };
    draft.headersSource = 'wire';
  }

  private async fetchBody(draft: Draft): Promise<void> {
    try {
      const { postData } = (await draft._session!.send('Network.getRequestPostData', {
        requestId: draft._cdpId!,
      })) as { postData: string };
      draft.postData = toPostData(Buffer.from(postData, 'utf8'));
      draft._needsBody = false;
    } catch {
      /* left for the Playwright fallback in finish() */
    }
  }

  /** Sandbox-mode WebSockets never reach the network stack, so the sandbox reports them here. */
  sandboxSocket(url: string): (data: string | Buffer) => void {
    const draft: Draft = {
      kind: 'websocket',
      source: 'sandbox',
      method: 'GET',
      url,
      resourceType: 'WebSocket',
      wallTime: Date.now(),
      pageIndex: 0,
      requestHeaders: {},
      headersSource: 'provisional',
      framesSent: [],
      step: this.currentStep,
    };
    this.drafts.push(draft);
    this.lastActivity = Date.now();
    return (data) => {
      this.lastActivity = Date.now();
      draft.framesSent!.push({
        wallTime: Date.now(),
        postData: toPostData(typeof data === 'string' ? Buffer.from(data, 'utf8') : data),
      });
    };
  }

  /** Resolves once no request has started for `quietMs`, or after `maxMs` at the latest. */
  async waitForQuiet(quietMs: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const idleFor = Date.now() - this.lastActivity;
      if (idleFor >= quietMs) return;
      await new Promise((r) => setTimeout(r, Math.min(100, quietMs - idleFor + 5)));
    }
  }

  /** Stops recording and returns the final, ordered list of records. */
  async finish(): Promise<RequestRecord[]> {
    await Promise.allSettled(this.work);

    // Reconcile with Playwright's view: add anything the CDP sessions did not see,
    // and borrow bodies that CDP could not hand over.
    const unmatched = new Map<string, Draft[]>();
    for (const d of this.drafts) {
      if (d.kind !== 'http') continue;
      const key = `${d.method} ${d.url}`;
      unmatched.set(key, [...(unmatched.get(key) ?? []), d]);
    }
    for (const seen of this.pwSeen) {
      const { request } = seen;
      // Pair each automation-layer request with the browser-log record closest to it in time.
      const candidates = unmatched.get(`${request.method()} ${request.url()}`) ?? [];
      let best = -1;
      candidates.forEach((c, i) => {
        const gap = Math.abs(c.wallTime - seen.wallTime);
        if (gap <= 5000 && (best === -1 || gap < Math.abs(candidates[best]!.wallTime - seen.wallTime))) best = i;
      });
      const twin = best === -1 ? undefined : candidates.splice(best, 1)[0];
      if (twin) {
        if (!twin.postData && twin._needsBody) {
          const buf = request.postDataBuffer();
          if (buf) twin.postData = toPostData(buf);
        }
        continue;
      }
      const draft: Draft = {
        kind: 'http',
        source: 'playwright',
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        wallTime: seen.wallTime,
        pageIndex: seen.pageIndex,
        requestHeaders: lowerKeys(await request.allHeaders().catch(() => request.headers())),
        headersSource: 'provisional',
        step: seen.step,
      };
      const buf = request.postDataBuffer();
      if (buf) draft.postData = toPostData(buf);
      const response = await request.response().catch(() => null);
      if (response) {
        draft.response = {
          status: response.status(),
          statusText: response.statusText(),
          headers: lowerKeys(await response.allHeaders().catch(() => response.headers())),
        };
      } else if (request.failure()) {
        draft.failure = request.failure()!.errorText;
      }
      this.drafts.push(draft);
    }

    for (const session of this.sessions) await session.detach?.().catch(() => undefined);

    // Stable order: by time, ties broken by the order events arrived in.
    const ordered = this.drafts
      .map((draft, arrival) => ({ draft, arrival }))
      .sort((a, b) => a.draft.wallTime - b.draft.wallTime || a.arrival - b.arrival)
      .map((x) => x.draft);
    const idOf = new Map<Draft, string>();
    ordered.forEach((draft, i) => idOf.set(draft, `r${String(i + 1).padStart(4, '0')}`));

    return ordered.map((draft, i) => {
      const { _cdpId, _session, _needsBody, ...rest } = draft;
      const from: Draft | undefined = (draft as any)._redirectedFromDraft;
      delete (rest as any)._redirectedFromDraft;
      return {
        id: idOf.get(draft)!,
        seq: i + 1,
        ...rest,
        ...(from ? { redirectedFrom: idOf.get(from)! } : {}),
      };
    });
  }
}
