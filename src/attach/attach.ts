import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateCanary } from '../canary/generate.js';
import { Recorder } from '../capture/recorder.js';
import { sandboxAnswer } from '../capture/sandbox.js';
import { describeStep, substitute, type Journey } from '../journey/schema.js';
import type { RunResult } from '../journey/runner.js';
import { serveFolder, type LocalSite } from '../serve/static-server.js';
import type { RunInfo, StepRecord } from '../types.js';
import { hostMatches, hostOf, registrableDomain } from '../util/domains.js';
import { ownHosts, resolveAliases } from '../capture/dns.js';
import { cryptoRng, seededRng } from '../util/random.js';
import { PLAYWRIGHT_VERSION, TOOL } from '../version.js';
import { CdpConnection } from './cdp-client.js';

/** What the person sees and does while Khara Check listens. */
export interface AttachIo {
  /** Shows a block of text to the person. */
  show(text: string): void;
  /**
   * Each value is one press of Enter, optionally with a note of what the person just did.
   * The iterator ends (or yields "done") when the person has finished.
   */
  marks: AsyncIterable<string>;
}

export interface AttachOptions {
  /** DevTools address of the person's browser, e.g. http://127.0.0.1:9222 */
  endpoint: string;
  outDir: string;
  seed?: string;
  io: AttachIo;
  /** Called once the planted values are known and Khara Check is listening (used by tests and the panel). */
  onReady?(info: { origin: string; values: Record<string, string> }): void;
}

const LISTEN_TYPES = new Set(['page', 'iframe', 'worker', 'shared_worker', 'service_worker']);

/**
 * Listen-only capture. A person browses in their own Chrome; Khara Check connects over the
 * DevTools Protocol and enables only the Network domain on each tab and frame. It never
 * clicks, types, or runs code in the page. The site sees an ordinary person in an
 * ordinary browser, and the evidence records that a person did every step.
 */
export async function attachJourney(journey: Journey, opts: AttachOptions): Promise<RunResult> {
  const sandbox = journey.network.mode === 'sandbox';
  const rng = opts.seed ? seededRng(opts.seed) : cryptoRng();
  const canaries = Object.entries(journey.canaries).map(([name, spec]) =>
    generateCanary(name, spec, { rng, allowGeneratedPhone: sandbox }),
  );
  const values = Object.fromEntries(canaries.map((c) => [c.name, c.value]));
  const labels = Object.fromEntries(canaries.map((c) => [c.name, c.label]));

  let localSite: LocalSite | undefined;
  if (journey.site.serve) localSite = await serveFolder(journey.site.serve, journey.site.port);
  const origin = localSite?.origin ?? journey.site.url!;
  mkdirSync(opts.outDir, { recursive: true });

  const conn = await CdpConnection.connect(opts.endpoint);
  const recorder = new Recorder();
  const startedAt = Date.now();
  const steps: StepRecord[] = [];
  const notes: string[] = [
    'Captured while a person browsed in their own browser. Khara Check only listened: it enabled the browser\'s network log and did not click, type or run code in the page.',
  ];
  if (sandbox) {
    notes.push('Sandbox run: requests to third parties were recorded and then answered on this machine. Nothing was delivered to any outside company.');
  }

  // Which page each session belongs to, and the latest URL of each top-level page.
  const pageOfSession = new Map<string, number>();
  const pageTargets: string[] = [];
  const sessionOfPage = new Map<number, string>();
  const pageUrl = new Map<string, string>();
  let lastActivePage = 0;
  let shots = 0;

  const addStep = (step: Omit<StepRecord, 'index' | 'endedAt'>): StepRecord => {
    const prev = steps[steps.length - 1];
    if (prev && !prev.endedAt) prev.endedAt = step.startedAt;
    const record: StepRecord = { ...step, index: steps.length, endedAt: 0 };
    steps.push(record);
    recorder.currentStep = record.index;
    return record;
  };

  const screenshot = async (pageIndex: number, name: string): Promise<string | undefined> => {
    const sessionId = sessionOfPage.get(pageIndex);
    if (!sessionId) return undefined;
    try {
      const { data } = await conn.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      mkdirSync(path.join(opts.outDir, 'screenshots'), { recursive: true });
      const file = `screenshots/${String(++shots).padStart(2, '0')}-${name}.png`;
      writeFileSync(path.join(opts.outDir, file), Buffer.from(data, 'base64'));
      return file;
    } catch {
      return undefined;
    }
  };

  const onAttached = async (params: any, parentSession: string | undefined): Promise<void> => {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    const type: string = targetInfo.type;
    const session = conn.session(sessionId);
    try {
      if (type === 'page') {
        const index = pageTargets.length;
        pageTargets.push(targetInfo.targetId);
        pageOfSession.set(sessionId, index);
        sessionOfPage.set(index, sessionId);
      } else {
        pageOfSession.set(sessionId, parentSession ? (pageOfSession.get(parentSession) ?? 0) : 0);
      }
      if (LISTEN_TYPES.has(type)) {
        await recorder.tap(session, pageOfSession.get(sessionId)!);
        if (sandbox) await conn.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
      }
      // Follow cross-site frames and workers started by this target.
      await conn
        .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
        .catch(() => undefined);
    } finally {
      if (waitingForDebugger) await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    }
  };

  conn.on('Target.attachedToTarget', (params, parent) => void onAttached(params, parent));

  if (sandbox) {
    conn.on('Fetch.requestPaused', (params, sessionId) => {
      const { requestId, request, resourceType } = params;
      let url: URL | null = null;
      try {
        url = new URL(request.url);
      } catch {
        url = null;
      }
      if (url && url.origin === origin) {
        void conn.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => undefined);
        return;
      }
      if (!url || !/^https?:$/.test(url.protocol)) {
        void conn.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
        return;
      }
      const answer = sandboxAnswer(url, request.method, String(resourceType ?? 'Other'), journey.network.stubs);
      void conn
        .send(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: answer.status,
            responseHeaders: Object.entries(answer.headers).map(([name, value]) => ({ name, value })),
            body: answer.body.toString('base64'),
          },
          sessionId,
        )
        .catch(() => undefined);
    });
  }

  // Top-level navigations become steps of the journey, with a screenshot once the page settles.
  conn.on('Target.targetInfoChanged', ({ targetInfo }) => {
    if (targetInfo.type !== 'page') return;
    const index = pageTargets.indexOf(targetInfo.targetId);
    if (index === -1 || !/^https?:/.test(targetInfo.url)) return;
    if (pageUrl.get(targetInfo.targetId) === targetInfo.url) return;
    pageUrl.set(targetInfo.targetId, targetInfo.url);
    lastActivePage = index;
    const step = addStep({
      action: 'navigate',
      label: `Page ${index + 1} went to ${shortUrl(targetInfo.url)}`,
      startedAt: Date.now(),
      pageUrl: targetInfo.url,
      ok: true,
      actor: 'person',
    });
    setTimeout(() => {
      void screenshot(index, 'page').then((file) => {
        if (file) step.artifact = file;
      });
    }, 1200);
  });

  await conn.send('Target.setDiscoverTargets', { discover: true });
  await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  const browserInfo = await conn.send('Browser.getVersion').catch(() => ({}) as any);

  addStep({ action: 'listen', label: 'Khara Check started listening', startedAt, pageUrl: '', ok: true, actor: 'khara-check' });
  opts.onReady?.({ origin, values });

  const width = Math.max(...canaries.map((c) => c.label.length));
  opts.io.show(
    [
      `Listening to your browser. Do the journey by hand, at your own pace:`,
      '',
      ...journey.steps.map((s, i) => {
        const text = 'text' in s ? `  ${substitute(s.text, values)}` : '';
        const where = s.action === 'goto' ? `  ${absolute(s.url, origin)}` : '';
        return `  ${String(i + 1).padStart(2)}. ${s.label ?? describeStep(s, labels).replace(/^Opened /, 'Open ')}${where}${text}`;
      }),
      '',
      'Planted values. Type these exactly:',
      ...canaries.map((c) => `  ${c.label.padEnd(width)}   ${c.value}`),
      '',
      'After each thing you do, press Enter here (you can type a note first, like "pressed search").',
      'Type "done" and press Enter when you have finished.',
    ].join('\n'),
  );

  for await (const raw of opts.io.marks) {
    const note = raw.trim();
    if (note.toLowerCase() === 'done' || conn.closed) break;
    const step = addStep({
      action: 'mark',
      label: note || `Step marked by the tester`,
      startedAt: Date.now(),
      pageUrl: pageUrl.get(pageTargets[lastActivePage] ?? '') ?? '',
      ok: true,
      actor: 'person',
    });
    const file = await screenshot(lastActivePage, 'mark');
    if (file) step.artifact = file;
  }

  await recorder.waitForQuiet(1500, 10_000);
  addStep({ action: 'stop', label: 'Khara Check stopped listening', startedAt: Date.now(), pageUrl: '', ok: true, actor: 'khara-check' });
  const last = steps[steps.length - 1]!;
  last.endedAt = last.startedAt;

  const cookies: unknown[] = [];
  const records = await recorder.finish();
  if (sandbox) {
    for (const r of records) {
      try {
        r.sandbox = new URL(r.url).origin === origin ? 'passed-to-local-site' : 'answered-locally';
      } catch {
        r.sandbox = 'answered-locally';
      }
    }
  }
  if (sandbox) await Promise.all([...sessionOfPage.values()].map((sid) => conn.send('Fetch.disable', {}, sid).catch(() => undefined)));
  conn.close();
  await localSite?.close();

  const siteHost = hostOf(origin);
  const ownDomains = [...new Set([registrableDomain(siteHost), ...journey.site.firstParty.map((d) => d.toLowerCase())])];
  const dnsAliases = sandbox ? {} : await resolveAliases(ownHosts(records.map((r) => r.url), (h) => ownDomains.some((d) => hostMatches(h, d))));
  const run: RunInfo = {
    tool: TOOL,
    journeyName: journey.name,
    site: {
      name: journey.site.name,
      origin,
      firstPartyDomains: [...new Set([registrableDomain(siteHost), ...journey.site.firstParty.map((d) => d.toLowerCase())])],
    },
    mode: journey.network.mode,
    capture: 'attached',
    startedAt,
    endedAt: Date.now(),
    ...(opts.seed ? { seed: opts.seed } : {}),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      playwright: PLAYWRIGHT_VERSION,
      browser: String(browserInfo.product ?? 'Chrome').split('/')[0] ?? 'Chrome',
      browserVersion: String(browserInfo.product ?? '').split('/')[1] ?? 'unknown',
      userAgent: String(browserInfo.userAgent ?? ''),
      viewport: { width: 0, height: 0 },
      locale: journey.browser.locale,
      timezone: journey.browser.timezone,
      headless: /Headless/.test(String(browserInfo.userAgent ?? '')),
    },
    steps,
    notes,
    ...(Object.keys(dnsAliases).length ? { dns: dnsAliases } : {}),
  };
  return { run, canaries, records, cookies };
}

function absolute(url: string, origin: string): string {
  return /^https?:\/\//i.test(url) ? url : origin + (url.startsWith('/') ? '' : '/') + url;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = u.pathname + u.search;
    return u.host + (rest.length > 60 ? rest.slice(0, 57) + '…' : rest);
  } catch {
    return url;
  }
}
