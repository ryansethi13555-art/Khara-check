import { readFileSync } from 'node:fs';
import type { BrowserContext, Route } from 'playwright';
import { contentTypeFor, resolveFile } from '../serve/static-server.js';

/** Smallest valid transparent GIF: what a tracking pixel returns. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Chromium switches that make the sandbox hold even if a request slips past interception:
 * every hostname except this machine fails to resolve, and no proxy is used.
 */
export const SANDBOX_BROWSER_ARGS = [
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
  '--no-proxy-server',
  '--disable-quic',
];

export interface SandboxOptions {
  /** Origin of the local site, e.g. http://127.0.0.1:41234. Requests to it pass through. */
  localOrigin: string;
  /** Folder of canned third-party responses laid out as <host>/<path>. */
  stubsDir?: string;
  /** Called for every WebSocket frame a page tries to send to a third party. */
  onSocketFrame?: (url: string, data: string | Buffer) => void;
  onSocketOpen?: (url: string) => void;
}

export interface SandboxAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * What the sandbox answers in place of a third party. Shared by the automated runner
 * (Playwright routing) and the attach mode (DevTools Fetch interception).
 * `resourceType` is matched without regard to case ("Image" and "image" both work).
 */
export function sandboxAnswer(url: URL, method: string, resourceType: string, stubsDir?: string): SandboxAnswer {
  const base = { 'access-control-allow-origin': '*', 'x-khara-check-sandbox': 'answered-locally' };
  const type = resourceType.toLowerCase();
  if (method === 'OPTIONS') {
    return {
      status: 204,
      headers: { ...base, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' },
      body: Buffer.alloc(0),
    };
  }
  const stub = stubsDir ? resolveFile(stubsDir, `${url.hostname}${url.pathname}`) : null;
  if (stub && method === 'GET') {
    const known = contentTypeFor(stub);
    const contentType = known === 'application/octet-stream' && type === 'script' ? 'text/javascript; charset=utf-8' : known;
    return { status: 200, headers: { ...base, 'content-type': contentType }, body: readFileSync(stub) };
  }
  switch (type) {
    case 'image':
      return { status: 200, headers: { ...base, 'content-type': 'image/gif' }, body: PIXEL };
    case 'script':
      return { status: 200, headers: { ...base, 'content-type': 'text/javascript' }, body: Buffer.alloc(0) };
    case 'stylesheet':
      return { status: 200, headers: { ...base, 'content-type': 'text/css' }, body: Buffer.alloc(0) };
    case 'document':
      return {
        status: 200,
        headers: { ...base, 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from(
          '<!doctype html><title>Khara Check sandbox</title><p>This address was not contacted. Khara Check is running in sandbox mode.</p>',
        ),
      };
    default:
      return { status: 204, headers: base, body: Buffer.alloc(0) };
  }
}

/**
 * Sandbox mode: the page believes it is talking to its trackers, but every request to
 * anything other than the local site is answered on this machine and never sent.
 * The request itself (address, headers, body) is still recorded in full.
 */
export async function installSandbox(context: BrowserContext, opts: SandboxOptions): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.abort();
    }
    if (url.origin === opts.localOrigin) return route.continue();

    const answer = sandboxAnswer(url, request.method(), request.resourceType(), opts.stubsDir);
    return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
  });

  await context.routeWebSocket(/.*/, (ws) => {
    const target = ws.url();
    let origin = '';
    try {
      const u = new URL(target);
      origin = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    } catch {
      /* fall through: treated as third party */
    }
    if (origin === opts.localOrigin) {
      ws.connectToServer();
      return;
    }
    // Accept the socket locally and swallow what the page sends.
    opts.onSocketOpen?.(target);
    ws.onMessage((message) => opts.onSocketFrame?.(target, message));
  });
}
