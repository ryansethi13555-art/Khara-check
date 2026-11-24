import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachJourney } from '../../src/attach/attach.js';
import { writeEvidence } from '../../src/evidence/bundle.js';
import { verifyBundle, writeDerived } from '../../src/evidence/derive.js';
import { loadJourney } from '../../src/journey/schema.js';
import type { Analysis } from '../../src/types.js';

/**
 * The person's browser: a plain Chromium process started the way a tester would start Chrome,
 * with remote debugging on and a fresh profile. Khara Check did not launch it and does not drive it.
 * The "person" is played by a second, separate DevTools client.
 */
let browserProcess: ChildProcess;
let endpoint = '';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'khara-check-attach-'));

beforeAll(async () => {
  browserProcess = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--no-proxy-server',
      // Playwright launches Chromium without its sandbox by default, and so must this test:
      // GitHub's Ubuntu 24.04 runners block the user namespaces the sandbox needs, and Chromium
      // refuses to start its sandbox as root. The listen-only code under test is the same either way.
      '--no-sandbox',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  endpoint = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`Chromium did not start within 20 seconds:\n${buf.slice(-2000)}`)),
      20_000,
    );
    browserProcess.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited before it was ready (${signal ?? code}):\n${buf.slice(-2000)}`));
    });
    browserProcess.stderr!.on('data', (chunk) => {
      buf += String(chunk);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
  });
});

afterAll(() => {
  browserProcess?.kill();
});

/** A queue of Enter presses that the test feeds as the "person" works. */
function markQueue(): { marks: AsyncIterable<string>; press(note: string): void } {
  const waiting: ((v: IteratorResult<string>) => void)[] = [];
  const queued: string[] = [];
  return {
    press(note) {
      const w = waiting.shift();
      if (w) w({ value: note, done: false });
      else queued.push(note);
    },
    marks: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<string>>((resolve) => {
            const q = queued.shift();
            if (q !== undefined) resolve({ value: q, done: false });
            else waiting.push(resolve);
          }),
      }),
    },
  };
}

describe('khara-check attach (listen-only)', () => {
  it('records a journey done by a person and finds the same leaks as the automated run', async () => {
    const journey = loadJourney(path.resolve(__dirname, '../../journeys/examples/fixture-pharmacy.yaml'));
    const out = path.join(tmp, 'bundle');
    const queue = markQueue();
    const shown: string[] = [];
    let ready!: (info: { origin: string; values: Record<string, string> }) => void;
    const readyInfo = new Promise<{ origin: string; values: Record<string, string> }>((r) => (ready = r));

    const capture = attachJourney(journey, {
      endpoint,
      outDir: out,
      seed: 'attach-test',
      io: { show: (t) => shown.push(t), marks: queue.marks },
      onReady: ready,
    });
    const { origin, values } = await readyInfo;
    expect(shown.join('\n')).toContain(values.search!);

    // The person: an independent client clicking and typing in the already-open tab.
    const person = await chromium.connectOverCDP(endpoint);
    const page = person.contexts()[0]!.pages()[0]!;
    await page.goto(origin + '/');
    await page.locator('#q').pressSequentially(values.search!, { delay: 20 });
    queue.press('typed the medicine');
    await page.click('#search-button');
    await page.locator('.results').waitFor();
    queue.press('pressed search');
    await page.waitForTimeout(800);
    await page.click('#signup-link');
    await page.fill('#email', values.email!);
    await page.fill('#phone', values.phone!);
    await page.click('#signup-button');
    await page.locator('#done').waitFor();
    queue.press('created the account');
    await page.waitForTimeout(800);
    queue.press('done');

    const result = await capture;
    await person.close();

    expect(result.run.capture).toBe('attached');
    expect(result.run.steps.filter((s) => s.actor === 'person').length).toBeGreaterThanOrEqual(5);
    writeEvidence(out, { journeyText: journey.sourceText, run: result.run, canaries: result.canaries, records: result.records, cookies: [] });
    writeDerived(out);

    const analysis = JSON.parse(readFileSync(path.join(out, 'findings.json'), 'utf8')) as Analysis;
    const pairs = [...new Set(analysis.leaks.map((f) => `${f.recipient.product ?? f.recipient.domain} <- ${f.canary}`))].sort();
    expect(pairs).toEqual(
      [
        'Meta Pixel <- search',
        'Meta Pixel <- email',
        'Meta Pixel <- phone',
        'Google Ads <- search',
        'Google Ads <- email',
        'Google Ads <- phone',
        'Google Analytics 4 <- search',
        'CleverTap <- search',
        'Criteo OneTag <- search',
        'adpartner-sample.example <- search',
      ].sort(),
    );
    for (const f of analysis.leaks) expect(f.delivery).toBe('sandboxed');
    expect(readFileSync(path.join(out, 'report.html'), 'utf8')).toContain('Done by a person');
    expect(verifyBundle(out).ok).toBe(true);
  });
});
