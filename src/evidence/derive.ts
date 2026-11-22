import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyze } from '../findings/analyze.js';
import { renderReports } from '../report/index.js';
import type { ReportModel } from '../report/model.js';
import type { Analysis } from '../types.js';
import { sha256Hex } from '../util/hash.js';
import {
  chainEvidence,
  evidenceFiles,
  loadBundle,
  PATHS,
  serializeAnalysis,
  writeManifest,
  type LoadedBundle,
  type Manifest,
  type ManifestEntry,
} from './bundle.js';

export interface Derived {
  bundle: LoadedBundle;
  entries: ManifestEntry[];
  seal: string;
  analysis: Analysis;
  model: ReportModel;
  files: { findings: string; html: string; markdown: string };
}

/**
 * Everything that can be worked out from the evidence alone: the seal, the findings and
 * both reports. No browser, no network, no clock. `run`, `report` and `verify` all use
 * this one function, which is why a verified bundle reproduces its report byte for byte.
 */
export function derive(dir: string): Derived {
  const bundle = loadBundle(dir);
  const entries = evidenceFiles(dir).map((rel) => {
    const data = readFileSync(path.join(dir, rel));
    return { path: rel, bytes: data.length, sha256: sha256Hex(data) };
  });
  const { seal } = chainEvidence(entries);
  const analysis = analyze(bundle.run, bundle.canaries, bundle.records);
  const reports = renderReports(bundle.run, analysis, bundle.records, seal);
  return {
    bundle,
    entries,
    seal,
    analysis,
    model: reports.model,
    files: { findings: serializeAnalysis(analysis), html: reports.html, markdown: reports.markdown },
  };
}

/** Writes findings, reports and the manifest into a bundle whose evidence is already in place. */
export function writeDerived(dir: string): Derived & { manifest: Manifest } {
  const derived = derive(dir);
  writeFileSync(path.join(dir, PATHS.findings), derived.files.findings);
  writeFileSync(path.join(dir, PATHS.reportHtml), derived.files.html);
  writeFileSync(path.join(dir, PATHS.reportMd), derived.files.markdown);
  const manifest = writeManifest(dir, derived.bundle.run);
  return { ...derived, manifest };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Verification {
  ok: boolean;
  checks: Check[];
  seal: string;
}

/** Independently re-checks a bundle: integrity first, then the analysis itself. */
export function verifyBundle(dir: string, opts: { expectedSeal?: string } = {}): Verification {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void checks.push({ name, ok, detail });

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, PATHS.manifest), 'utf8')) as Manifest;
  } catch {
    add('Manifest', false, 'manifest.json is missing or unreadable, so there is nothing to check against');
    return { ok: false, checks, seal: '' };
  }

  // 1. Every evidence file is present and unchanged; nothing was added.
  const present = new Set(evidenceFiles(dir));
  const problems: string[] = [];
  for (const e of manifest.evidence) {
    const full = path.join(dir, e.path);
    if (!existsSync(full)) problems.push(`${e.path} is missing`);
    else if (sha256Hex(readFileSync(full)) !== e.sha256) problems.push(`${e.path} has been changed`);
    present.delete(e.path);
  }
  for (const extra of present) problems.push(`${extra} is not in the manifest`);
  add(
    'Evidence files',
    !problems.length,
    problems.length ? problems.join('; ') : `${manifest.evidence.length} files match their recorded SHA-256 fingerprints`,
  );

  // 2. The chain over those fingerprints gives the recorded seal.
  const { seal } = chainEvidence(manifest.evidence.map(({ path: p, bytes, sha256 }) => ({ path: p, bytes, sha256 })));
  add('Evidence seal', seal === manifest.seal, seal === manifest.seal ? seal : `the chain gives ${seal}, but the manifest says ${manifest.seal}`);
  if (opts.expectedSeal) {
    const want = opts.expectedSeal.trim().toLowerCase();
    add('Published seal', want === seal, want === seal ? 'matches the seal you supplied' : `you supplied ${want}, but this bundle seals to ${seal}`);
  }

  // 3. The request log is internally chained: no line removed, added or reordered.
  let derived: Derived | undefined;
  try {
    derived = derive(dir);
    const b = derived.bundle;
    const logOk = b.logBrokenAt === undefined && b.logHead === manifest.requestLog.head && b.records.length === manifest.requestLog.records;
    add(
      'Request log chain',
      logOk,
      logOk
        ? `${b.records.length} requests, each line linked to the one before it`
        : b.logBrokenAt !== undefined
          ? `the chain breaks at line ${b.logBrokenAt}`
          : 'the log does not end where the manifest says it should',
    );
  } catch (err) {
    add('Request log chain', false, `the capture could not be read: ${(err as Error).message}`);
  }

  // 4. Re-run the analysis from the raw capture and compare with what the bundle claims.
  if (derived) {
    const compare = (name: string, rel: string, fresh: string, what: string): void => {
      let stored: string | null = null;
      try {
        stored = readFileSync(path.join(dir, rel), 'utf8');
      } catch {
        stored = null;
      }
      add(
        name,
        stored === fresh,
        stored === null ? `${rel} is missing` : stored === fresh ? what : `${rel} does not match what the evidence produces. It was edited, or made by a different khara-check version`,
      );
    };
    const a = derived.analysis;
    compare(
      'Findings reproduce',
      PATHS.findings,
      derived.files.findings,
      `re-ran the analysis from the raw capture: ${a.leaks.length} third-party ${a.leaks.length === 1 ? 'finding' : 'findings'}, identical to findings.json`,
    );
    compare('HTML report reproduces', PATHS.reportHtml, derived.files.html, 'report.html is exactly what the evidence produces');
    compare('Markdown report reproduces', PATHS.reportMd, derived.files.markdown, 'report.md is exactly what the evidence produces');
  }

  return { ok: checks.every((c) => c.ok), checks, seal };
}
