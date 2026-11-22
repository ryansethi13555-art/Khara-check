import type { CdpSessionLike } from '../capture/recorder.js';

type Handler = (params: any, sessionId: string | undefined) => void;

/**
 * A minimal Chrome DevTools Protocol client over one WebSocket, in "flat" session mode.
 * Khara Check uses it to listen to a browser it did not start, without Playwright attaching its
 * own machinery (Playwright enables the Runtime domain on every page, which a site can notice).
 */
export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Map<string, Set<Handler>>();
  private closedHandlers: (() => void)[] = [];
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => this.onMessage(String(event.data)));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`browser connection closed during ${p.method}`));
      this.pending.clear();
      for (const h of this.closedHandlers) h();
    });
  }

  /** Accepts http://host:port (as given to --remote-debugging-port) or a ws:// browser endpoint. */
  static async connect(endpoint: string, timeoutMs = 10_000): Promise<CdpConnection> {
    let wsUrl = endpoint;
    if (/^https?:\/\//i.test(endpoint)) {
      const base = endpoint.replace(/\/+$/, '');
      let res: Response;
      try {
        res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new Error(
          `No browser is listening at ${endpoint}. Start Chrome with --remote-debugging-port=9222 and a separate --user-data-dir (see "khara-check attach --help").`,
        );
      }
      const info = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (!info.webSocketDebuggerUrl) throw new Error(`${endpoint} did not report a DevTools WebSocket address`);
      wsUrl = info.webSocketDebuggerUrl;
    }
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${wsUrl}`)), timeoutMs);
      ws.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true });
      ws.addEventListener('error', () => (clearTimeout(timer), reject(new Error(`Could not connect to ${wsUrl}`))), { once: true });
    });
    return new CdpConnection(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error('browser connection is closed'));
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(message);
    });
  }

  on(event: string, handler: Handler): void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
  }

  onClose(handler: () => void): void {
    this.closedHandlers.push(handler);
  }

  /** A view of one attached target that looks like any other DevTools session. */
  session(sessionId: string): CdpSessionLike {
    return {
      on: (event, handler) =>
        this.on(event, (params, sid) => {
          if (sid === sessionId) handler(params);
        }),
      send: (method, params) => this.send(method, params ?? {}, sessionId),
      detach: async () => {
        await this.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      },
    };
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  private onMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const set = this.handlers.get(msg.method);
    if (set) for (const h of set) h(msg.params, msg.sessionId);
  }
}
