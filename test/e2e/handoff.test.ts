import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeEvidence } from '../../src/evidence/bundle.js';
import { verifyBundle, writeDerived } from '../../src/evidence/derive.js';
import { runJourney } from '../../src/journey/runner.js';
import { loadJourney } from '../../src/journey/schema.js';
import type { Analysis } from '../../src/types.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'khara-check-handoff-'));
const journey = loadJourney(path.resolve(__dirname, '../../journeys/fixtures/f9.yaml'));

describe('human handoff at a bot check', () => {
  it('stops with an explanation when nobody is watching', async () => {
    const result = await runJourney(journey, { outDir: path.join(tmp, 'alone'), headless: true, seed: 'h1', log: () => {} });
    expect(result.failure).toMatch(/bot check \(Cloudflare check\).*--headed/);
    expect(result.run.handoffs?.[0]).toMatchObject({ ok: false, action: 'handoff' });
    // It stopped at the wall: nothing was typed.
    expect(result.run.steps).toHaveLength(1);
  });

  it('pauses for a person, records the handoff, and carries on in the same session', async () => {
    const out = path.join(tmp, 'watched');
    const messages: string[] = [];
    const result = await runJourney(journey, {
      outDir: out,
      headless: true,
      seed: 'h2',
      log: () => {},
      // The "person": clears the wall in the open browser, then says they are done.
      handoff: async (message, { page }) => {
        messages.push(message);
        await page.click('#human');
        await page.waitForURL(/scenario=f1/);
      },
    });
    expect(result.failure).toBeUndefined();
    expect(messages[0]).toMatch(/bot check/);
    expect(result.run.handoffs).toHaveLength(1);
    expect(result.run.handoffs![0]).toMatchObject({ ok: true, actor: 'person', index: 0 });
    expect(result.run.notes.join(' ')).toMatch(/cleared by a person\. Khara Check does not solve bot checks/);

    writeEvidence(out, { journeyText: journey.sourceText, run: result.run, canaries: result.canaries, records: result.records, cookies: [] });
    const derived = writeDerived(out);
    expect(derived.entries.map((e) => e.path)).toEqual(expect.arrayContaining(['handoffs/01-before.png', 'handoffs/01-after.png']));
    const analysis = JSON.parse(readFileSync(path.join(out, 'findings.json'), 'utf8')) as Analysis;
    expect(analysis.leaks.some((f) => f.recipient.product === 'Meta Pixel' && f.canary === 'search')).toBe(true);
    expect(readFileSync(path.join(out, 'report.html'), 'utf8')).toContain('a person cleared it by hand');
    expect(verifyBundle(out).ok).toBe(true);
  });
});
