import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Analysis } from '../../src/types.js';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const CLI = [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/cli.ts')];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'khara-check-consent-'));

async function cli(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [...CLI, ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
  return stdout;
}

const leaks = (dir: string): Analysis['leaks'] => (JSON.parse(readFileSync(path.join(dir, 'findings.json'), 'utf8')) as Analysis).leaks;
const who = (l: Analysis['leaks']): string[] => [...new Set(l.map((f) => f.recipient.product ?? f.recipient.domain))].sort();

describe('consent: does "Reject all" work?', () => {
  it('tags each leak with the consent state and compares the three conditions', async () => {
    const out = path.join(tmp, 'consent');
    const stdout = await cli('run', 'journeys/examples/fixture-consent.yaml', '--consent', 'all', '--out', out, '--seed', 'consent');

    // Banner ignored: Meta and GA4 get the search before any choice. Criteo waits for consent.
    const ignored = leaks(path.join(out, 'no-choice'));
    expect(who(ignored)).toEqual(['Google Analytics 4', 'Meta Pixel']);
    expect(ignored.every((f) => f.consent === 'before-choice')).toBe(true);

    // After "Reject all": the same two still receive it. That is the finding.
    const rejected = leaks(path.join(out, 'reject'));
    expect(who(rejected)).toEqual(['Google Analytics 4', 'Meta Pixel']);
    expect(rejected.every((f) => f.consent === 'after-reject')).toBe(true);

    // After "Accept all": Criteo joins.
    expect(who(leaks(path.join(out, 'accept')))).toEqual(['Criteo OneTag', 'Google Analytics 4', 'Meta Pixel']);

    expect(stdout).toMatch(/Even after the customer pressed "Reject all", the medicine search went to Google and Meta/);
    const html = readFileSync(path.join(out, 'compare.html'), 'utf8');
    expect(html).toContain('"Reject all" did not stop <em>2 companies</em>');
    for (const c of ['no-choice', 'reject', 'accept']) expect(html).toContain(`${c}/report.html`);
  });
});

describe('fleet: many sites, one scorecard', () => {
  it('ranks sites, counts companies told, and separates the clean site', async () => {
    const out = path.join(tmp, 'fleet');
    await cli('fleet', 'journeys/fleet-example.yaml', '--out', out, '--seed', 'fleet');
    const md = readFileSync(path.join(out, 'compare.md'), 'utf8');
    expect(md).toMatch(/## Practice Pharmacy C[\s\S]*Even after the customer pressed "Reject all"/);
    expect(md).toMatch(/## Practice Pharmacy B\n\n- Nothing the customer typed left the site in any run\./);
    const html = readFileSync(path.join(out, 'compare.html'), 'utf8');
    expect(html).toContain('2 of 3 sites told other companies what the customer typed.');
    // C (ignores Reject all) ranks first, then A (leaks without a banner), then B (clean).
    const order = ['Practice Pharmacy C', 'Practice Pharmacy A', 'Practice Pharmacy B'].map((s) => html.indexOf(`>${s}</a>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
