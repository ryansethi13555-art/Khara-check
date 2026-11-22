import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { generateCanary } from '../canary/generate.js';
import { Recorder } from '../capture/recorder.js';
import { installSandbox, SANDBOX_BROWSER_ARGS } from '../capture/sandbox.js';
import { serveFolder, type LocalSite } from '../serve/static-server.js';
import type { Canary, RequestRecord, RunInfo, StepRecord } from '../types.js';
import { hostMatches, hostOf, registrableDomain } from '../util/domains.js';
import { ownHosts, resolveAliases } from '../capture/dns.js';
import { cryptoRng, seededRng } from '../util/random.js';
import { PLAYWRIGHT_VERSION, TOOL } from '../version.js';
import { detectChallenge } from './challenge.js';
import { describeStep, substitute, type Journey, type Step } from './schema.js';

export type ConsentChoice = 'no-choice' | 'reject' | 'accept';

export interface RunOptions {
  /** Folder the evidence bundle is being written into. Screenshots go here as they are taken. */
  outDir: string;
  headless: boolean;
  /** Makes the generated canaries reproducible. Leave unset for real runs. */
  seed?: string;
  log: (message: string) => void;
  /** How to answer the site's consent banner, when the journey describes one. Default: no choice. */
  consent?: ConsentChoice;
  /**
   * Hands the visible browser to a person and resolves when they are done (they press Enter).
   * Only provided when a person is watching (`--headed`). Without it, a bot check or a
   * handoff step stops the run with an explanation.
   */
  handoff?: (message: string, ctx: { page: Page }) => Promise<void>;
}

export interface RunResult {
  run: RunInfo;
  canaries: Canary[];
  records: RequestRecord[];
  cookies: unknown[];
  /** Set when a step failed. The capture up to that point is still returned. */
  failure?: string;
}

export async function runJourney(journey: Journey, opts: RunOptions): Promise<RunResult> {
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

  const browser = await chromium.launch({
    headless: opts.headless,
    args: sandbox ? SANDBOX_BROWSER_ARGS : [],
  });
  const startedAt = Date.now();
  const steps: StepRecord[] = [];
  const consentChoice: ConsentChoice = journey.consent ? (opts.consent ?? 'no-choice') : 'no-choice';
  const notes: string[] = [];
  const handoffs: StepRecord[] = [];
  let failure: string | undefined;

  try {
    // The browser is used as it is. Khara Check does not disguise automation: no altered
    // fingerprint, no stealth patches. A journey may set a user agent for ordinary device
    // emulation, and whatever was used is written into the bundle.
    const probe = await browser.newPage();
    const defaultUserAgent = await probe.evaluate(() => navigator.userAgent);
    await probe.close();
    const userAgent = journey.browser.userAgent ?? defaultUserAgent;

    const context = await browser.newContext({
      viewport: journey.browser.viewport,
      locale: journey.browser.locale,
      timezoneId: journey.browser.timezone,
      ...(journey.browser.userAgent ? { userAgent: journey.browser.userAgent } : {}),
    });
    context.setDefaultTimeout(15_000);

    const recorder = new Recorder(context);
    if (sandbox) {
      const sockets = new Map<string, (data: string | Buffer) => void>();
      await installSandbox(context, {
        localOrigin: origin,
        ...(journey.network.stubs ? { stubsDir: journey.network.stubs } : {}),
        onSocketOpen: (url) => sockets.set(url, recorder.sandboxSocket(url)),
        onSocketFrame: (url, data) => sockets.get(url)?.(data),
      });
      notes.push(
        'Sandbox run: requests to third parties were recorded and then answered on this machine. Nothing was delivered to any outside company.',
      );
    }

    const page = await context.newPage();
    await recorder.attachPage(page);

    for (const step of journey.steps) {
      // Index into the run's step list, which can also hold steps Khara Check adds (consent choices).
      const index = steps.length;
      const label = describeStep(step, labels);
      recorder.currentStep = index;
      const record: StepRecord = {
        index,
        action: step.action,
        label,
        startedAt: Date.now(),
        endedAt: 0,
        pageUrl: '',
        ok: true,
      };
      opts.log(`  ${String(index + 1).padStart(2)}. ${label}`);
      try {
        if (step.action === 'handoff') {
          record.actor = 'person';
          await handOver(page, step.say, step, opts, index, record);
          steps.push(finish(record, page));
          continue;
        }
        const artifact = await perform(page, step, { origin, values, outDir: opts.outDir, index });
        if (artifact) record.artifact = artifact;
        await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
        if (step.action !== 'wait' && step.action !== 'screenshot' && step.action !== 'snapshot') {
          await page.waitForTimeout(journey.settleMs);
        }
      } catch (err) {
        record.ok = false;
        record.error = firstLine((err as Error).message);
        if (step.action === 'handoff') record.error = (err as Error).message;
        failure = `Step ${index + 1} (${label}) failed: ${record.error}`;
        const shot = `screenshots/${String(index + 1).padStart(2, '0')}-failure.png`;
        await page.screenshot({ path: path.join(opts.outDir, shot) }).catch(() => undefined);
        record.artifact = shot;
      }
      steps.push(finish(record, page));
      if (failure) break;

      // A bot check is never solved by Khara Check. A person clears it, or the run stops here.
      const challenge = await detectChallenge(page);
      if (challenge) {
        const handoff: StepRecord = {
          index: steps.length,
          action: 'handoff',
          label: `The site showed a bot check (${challenge.kind}); a person cleared it by hand`,
          startedAt: Date.now(),
          endedAt: 0,
          pageUrl: page.url(),
          ok: true,
          actor: 'person',
        };
        recorder.currentStep = index;
        try {
          await handOver(page, `The site is showing a bot check (${challenge.kind}). Clear it in the browser window.`, { timeoutMs: 15 * 60_000 }, opts, index, handoff);
          notes.push(`A bot check (${challenge.kind}, seen as ${challenge.evidence}) appeared after step ${index + 1} and was cleared by a person. Khara Check does not solve bot checks.`);
        } catch (err) {
          handoff.ok = false;
          handoff.label = `The site showed a bot check (${challenge.kind})`;
          handoff.error = (err as Error).message;
          failure = `After step ${index + 1} the site showed a bot check (${challenge.kind}). ${(err as Error).message}`;
        }
        // Handoff records sit between journey steps; they carry the index of the step they follow.
        handoff.index = index;
        handoffs.push(finish(handoff, page));
        if (failure) break;
      }

      // Consent: under "reject" or "accept", answer the banner the moment it is on screen.
      if (journey.consent && consentChoice !== 'no-choice') {
        const selector = consentChoice === 'accept' ? journey.consent.accept : journey.consent.reject;
        const button = page.locator(selector).first();
        if (await button.isVisible().catch(() => false)) {
          const words = ((await button.innerText().catch(() => '')) || (consentChoice === 'accept' ? 'Accept' : 'Reject')).trim();
          const record: StepRecord = {
            index: steps.length,
            action: consentChoice === 'accept' ? 'consent-accept' : 'consent-reject',
            label: `Pressed "${words}" on the consent banner`,
            startedAt: Date.now(),
            endedAt: 0,
            pageUrl: page.url(),
            ok: true,
            actor: 'khara-check',
          };
          recorder.currentStep = record.index;
          opts.log(`      ${record.label}`);
          await button.click();
          await page.waitForTimeout(journey.settleMs);
          steps.push(finish(record, page));
        }
      }
    }

    // Let late beacons (page-hide, batched analytics) leave before we stop listening.
    await recorder.waitForQuiet(1200, 10_000);
    const cookies = await context.cookies().catch(() => []);
    const records = await recorder.finish();
    if (sandbox) {
      for (const r of records) {
        r.sandbox = sameOrigin(r.url, origin) ? 'passed-to-local-site' : 'answered-locally';
      }
    }
    if (failure) notes.push(failure);
    if (records.some((r) => r.source === 'playwright')) {
      notes.push(
        'Some requests were seen by the automation layer but not by the browser network log (for example from a service worker). They are included, marked source "playwright", without initiator details.',
      );
    }

    const siteHost = hostOf(origin);
    const ownDomains = [...new Set([registrableDomain(siteHost), ...journey.site.firstParty.map((d) => d.toLowerCase())])];
    // Live runs record where the site's own hostnames really point, to catch collectors disguised as the site.
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
      capture: 'automated',
      ...(journey.consent ? { consent: consentChoice } : {}),
      startedAt,
      endedAt: Date.now(),
      ...(opts.seed ? { seed: opts.seed } : {}),
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        playwright: PLAYWRIGHT_VERSION,
        browser: 'chromium',
        browserVersion: browser.version(),
        userAgent,
        viewport: journey.browser.viewport,
        locale: journey.browser.locale,
        timezone: journey.browser.timezone,
        headless: opts.headless,
      },
      steps,
      ...(handoffs.length ? { handoffs } : {}),
      notes,
      ...(Object.keys(dnsAliases).length ? { dns: dnsAliases } : {}),
    };
    await context.close();
    return { run, canaries, records, cookies, ...(failure ? { failure } : {}) };
  } finally {
    await browser.close().catch(() => undefined);
    await localSite?.close();
  }
}

function finish(record: StepRecord, page: Page): StepRecord {
  record.endedAt = Date.now();
  record.pageUrl = page.url();
  return record;
}

async function handOver(
  page: Page,
  message: string,
  step: { until?: string; timeoutMs: number },
  opts: RunOptions,
  index: number,
  record: StepRecord,
): Promise<void> {
  if (!opts.handoff) {
    throw new Error(
      'A person needs to take over here, and nobody is watching this run. Run again with --headed and clear it in the browser window, or record the journey by hand with "khara-check attach".',
    );
  }
  const prefix = `handoffs/${String(index + 1).padStart(2, '0')}`;
  mkdirSync(path.join(opts.outDir, 'handoffs'), { recursive: true });
  await page.screenshot({ path: path.join(opts.outDir, `${prefix}-before.png`) }).catch(() => undefined);
  const waits: Promise<unknown>[] = [opts.handoff(message, { page })];
  if (step.until) waits.push(page.locator(step.until).first().waitFor({ state: 'visible', timeout: step.timeoutMs }));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Nobody finished the handoff in time.')), step.timeoutMs);
  });
  try {
    await Promise.race([Promise.race(waits), timeout]);
  } finally {
    clearTimeout(timer);
  }
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
  await page.screenshot({ path: path.join(opts.outDir, `${prefix}-after.png`) }).catch(() => undefined);
  record.artifact = `${prefix}-after.png`;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    const scheme = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${scheme}//${u.host}` === origin;
  } catch {
    return false;
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0]!.replace(/\u001b\[[0-9;]*m/g, '').trim();
}

interface PerformContext {
  origin: string;
  values: Record<string, string>;
  outDir: string;
  index: number;
}

async function perform(page: Page, step: Step, ctx: PerformContext): Promise<string | undefined> {
  const fill = (text: string): string => substitute(text, ctx.values);
  const prefix = String(ctx.index + 1).padStart(2, '0');
  switch (step.action) {
    case 'goto': {
      const target = /^https?:\/\//i.test(step.url) ? step.url : ctx.origin + (step.url.startsWith('/') ? '' : '/') + step.url;
      await page.goto(fill(target), { waitUntil: 'load' });
      return;
    }
    case 'type':
      await page.locator(step.selector).first().pressSequentially(fill(step.text), { delay: step.delayMs });
      return;
    case 'fill':
      await page.locator(step.selector).first().fill(fill(step.text));
      return;
    case 'press':
      if (step.selector) await page.locator(step.selector).first().press(step.key);
      else await page.keyboard.press(step.key);
      return;
    case 'click':
      await page.locator(step.selector).first().click();
      return;
    case 'check':
      await page.locator(step.selector).first().check();
      return;
    case 'select':
      await page.locator(step.selector).first().selectOption(step.value);
      return;
    case 'waitFor':
      await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: step.timeoutMs });
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'screenshot': {
      const file = `screenshots/${prefix}-${step.name}.png`;
      await page.screenshot({ path: path.join(ctx.outDir, file), fullPage: true });
      return file;
    }
    case 'snapshot': {
      const file = `snapshots/${prefix}-${step.name}.html`;
      mkdirSync(path.join(ctx.outDir, 'snapshots'), { recursive: true });
      writeFileSync(path.join(ctx.outDir, file), await page.content(), 'utf8');
      return file;
    }
  }
}
