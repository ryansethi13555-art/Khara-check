import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Analysis, Canary } from '../../src/types.js';
import { bundleToHar } from '../support/to-har.js';

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const CLI = [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/cli.ts')];

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(process.execPath, [...CLI, ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1', ...env } });
    return { code: 0, stdout };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

const pairs = (a: Analysis): string[] =>
  [...new Set(a.leaks.map((f) => `${f.recipient.product ?? f.recipient.domain} <- ${f.canary} (${f.strongest})`))].sort();

describe('import: a HAR file a person saved from DevTools', () => {
  it('finds the same leaks as the watched run, seals the original file, and verify passes', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'khara-check-import-'));
    const watched = path.join(tmp, 'watched');
    expect((await cli(['run', 'journeys/examples/report-1-patterns.yaml', '--out', watched, '--seed', 'import'])).code).toBe(0);
    const harFile = path.join(tmp, 'recorded.har');
    writeFileSync(harFile, bundleToHar(watched));
    const canaries = JSON.parse(readFileSync(path.join(watched, 'canaries.json'), 'utf8')) as Canary[];
    const value = (n: string): string => canaries.find((c) => c.name === n)!.value;
    const origin = (JSON.parse(readFileSync(path.join(watched, 'run.json'), 'utf8')) as { site: { origin: string } }).site.origin;

    const imported = path.join(tmp, 'imported');
    const res = await cli(
      ['import', harFile, '--site', origin, '--name', 'Sample Pharmacy', '--search', value('search'), '--email', value('email'), '--phone-env', 'TEST_PHONE', '--unique', '--out', imported],
      { TEST_PHONE: value('phone') },
    );
    expect(res.code, res.stdout).toBe(0);

    const a = JSON.parse(readFileSync(path.join(watched, 'findings.json'), 'utf8')) as Analysis;
    const b = JSON.parse(readFileSync(path.join(imported, 'findings.json'), 'utf8')) as Analysis;
    expect(pairs(b)).toEqual(pairs(a));
    for (const f of b.leaks) expect(f.confidence).toBe('unique');

    // The person's phone number is only in canaries.json (needed to re-check), never in the journey file.
    expect(readFileSync(path.join(imported, 'journey.yaml'), 'utf8')).not.toContain(value('phone'));
    expect(readFileSync(path.join(imported, 'journey.yaml'), 'utf8')).toContain('TEST_PHONE');
    expect(readFileSync(path.join(imported, 'report.html'), 'utf8')).toContain('imported from a HAR file');
    const manifest = JSON.parse(readFileSync(path.join(imported, 'manifest.json'), 'utf8')) as { evidence: { path: string }[] };
    expect(manifest.evidence.map((e) => e.path)).toContain('capture/original.har');

    const verified = await cli(['verify', imported], { TEST_PHONE: '' });
    expect(verified.code, verified.stdout).toBe(0);

    // Without --unique the same values are weaker evidence, and the report says so.
    const weak = path.join(tmp, 'weak');
    expect((await cli(['import', harFile, '--site', origin, '--search', value('search'), '--out', weak])).code).toBe(0);
    const w = JSON.parse(readFileSync(path.join(weak, 'findings.json'), 'utf8')) as Analysis;
    expect(w.leaks.length).toBeGreaterThan(0);
    for (const f of w.leaks) expect(f.confidence).not.toBe('unique');
  });

  it('refuses a file that is not a HAR, and an import that names no typed value', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'khara-check-import-'));
    const bad = path.join(tmp, 'bad.har');
    writeFileSync(bad, '{"hello":1}');
    let res = await cli(['import', bad, '--site', 'https://pharmacy.example.in', '--search', 'metformin 500']);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/not a HAR file/);
    res = await cli(['import', bad, '--site', 'https://pharmacy.example.in']);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/what was typed/);
  });
});
