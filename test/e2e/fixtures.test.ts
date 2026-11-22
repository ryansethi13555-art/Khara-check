import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Analysis, Finding } from '../../src/types.js';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const CLI = [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/cli.ts')];

async function cli(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, [...CLI, ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
    return { code: 0, stdout };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

interface Expected {
  leaks: { recipient: string; canary: string; strongest: Finding['strongest']; fields: string[]; surface?: string }[];
  firstParty: string[];
  contactedWithoutLeak?: string[];
}

const name = (f: Finding): string => f.recipient.product ?? f.recipient.domain;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'khara-check-e2e-'));

describe('end to end against the practice site', () => {
  for (const scenario of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'r1']) {
    it(`${scenario}: finds exactly the expected leaks, and verify passes`, async () => {
      const out = path.join(tmp, scenario);
      const journey = scenario === 'r1' ? 'journeys/examples/report-1-patterns.yaml' : `journeys/fixtures/${scenario}.yaml`;
      const res = await cli('run', journey, '--out', out, '--seed', `e2e-${scenario}`);
      expect(res.code, res.stdout).toBe(0);

      const expected = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/expected', `${scenario}.json`), 'utf8')) as Expected;
      const analysis = JSON.parse(readFileSync(path.join(out, 'findings.json'), 'utf8')) as Analysis;

      // Same set of (recipient, canary) pairs: nothing missing, nothing extra.
      const got = [...new Set(analysis.leaks.map((f) => `${name(f)} <- ${f.canary}`))].sort();
      expect(got).toEqual(expected.leaks.map((e) => `${e.recipient} <- ${e.canary}`).sort());

      for (const e of expected.leaks) {
        const mine = analysis.leaks.filter((f) => name(f) === e.recipient && f.canary === e.canary);
        const strongest = mine.map((f) => f.strongest).sort((a, b) => ['plain', 'encoded', 'hash'].indexOf(a) - ['plain', 'encoded', 'hash'].indexOf(b))[0];
        expect(strongest, `${e.recipient} <- ${e.canary}`).toBe(e.strongest);
        const fields = mine.flatMap((f) => f.sightings.map((s) => s.field.replace(/^line \d+ › /, '')));
        for (const field of e.fields) expect(fields, `${e.recipient} <- ${e.canary}`).toContain(field);
        if (e.surface) expect(mine.flatMap((f) => f.sightings.map((s) => s.surface))).toContain(e.surface);
        for (const f of mine) expect(f.confidence).toBe('unique');
        for (const f of mine) expect(f.delivery).toBe('sandboxed');
      }

      expect([...new Set(analysis.firstParty.map((f) => f.canary))].sort()).toEqual([...expected.firstParty].sort());
      for (const quiet of expected.contactedWithoutLeak ?? []) {
        const party = analysis.contacted.find((c) => (c.recipient.product ?? c.recipient.domain) === quiet);
        expect(party, `${quiet} should be contacted`).toBeDefined();
        expect(party!.receivedCanary).toBe(false);
      }

      // Every finding points at a real recorded request.
      const log = readFileSync(path.join(out, 'capture/requests.jsonl'), 'utf8');
      for (const f of analysis.leaks) expect(log).toContain(`"id":"${f.requestId}"`);

      const verified = await cli('verify', out);
      expect(verified.code, verified.stdout).toBe(0);
    });
  }
});

describe('tamper detection', () => {
  it('verify fails when one byte of the capture changes, and when a finding is edited', async () => {
    const out = path.join(tmp, 'tamper');
    expect((await cli('run', 'journeys/fixtures/f1.yaml', '--out', out, '--seed', 'tamper')).code).toBe(0);
    const seal = /Seal\s+([0-9a-f]{64})/.exec((await cli('report', out)).stdout)?.[1];

    // Edit a finding but leave the evidence alone: integrity holds, reproduction fails.
    const findingsPath = path.join(out, 'findings.json');
    const original = readFileSync(findingsPath, 'utf8');
    writeFileSync(findingsPath, original.replace('"Meta Pixel"', '"Someone Else"'));
    let res = await cli('verify', out);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/✗ Findings reproduce/);
    expect(res.stdout).toMatch(/✓ Evidence seal/);
    writeFileSync(findingsPath, original);

    // Change one character of the raw capture.
    const logPath = path.join(out, 'capture/requests.jsonl');
    const log = readFileSync(logPath, 'utf8');
    writeFileSync(logPath, log.replace('search_string', 'search_strinG'));
    res = await cli('verify', out);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/✗ Evidence files .*capture\/requests\.jsonl has been changed/);
    // And `report` refuses to re-seal tampered evidence.
    res = await cli('report', out);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/Refusing to re-seal/);
    writeFileSync(logPath, log);

    // Restored: verifies again, against the published seal too.
    expect(seal).toBeDefined();
    res = await cli('verify', out, '--seal', seal ?? '');
    expect(res.code, res.stdout).toBe(0);
  });

  it('refuses to overwrite an existing evidence folder', async () => {
    const out = path.join(tmp, 'tamper');
    const res = await cli('run', 'journeys/fixtures/f1.yaml', '--out', out);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/never overwritten/);
  });
});
