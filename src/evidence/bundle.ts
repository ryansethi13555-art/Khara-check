import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Analysis, Canary, RequestRecord, RunInfo } from '../types.js';
import { canonicalJson, prettyCanonicalJson, sha256Hex } from '../util/hash.js';

/**
 * Layout of an evidence bundle.
 *
 *   journey.yaml              the exact script that was run
 *   run.json                  who, what, when, with which browser; the step timeline
 *   canaries.json             the planted values
 *   capture/requests.jsonl    every request, one per line, each line chained to the one before
 *   capture/cookies.json      cookies left in the browser at the end
 *   screenshots/, snapshots/  what the page looked like
 *   manifest.json             SHA-256 of every evidence file, chained into one seal
 *   SEAL.txt                  the seal, for publishing or timestamping
 *
 *   findings.json             derived from the evidence, reproducible with `khara-check verify`
 *   report.html, report.md    derived from the findings
 */
export const PATHS = {
  journey: 'journey.yaml',
  run: 'run.json',
  canaries: 'canaries.json',
  requests: 'capture/requests.jsonl',
  cookies: 'capture/cookies.json',
  manifest: 'manifest.json',
  seal: 'SEAL.txt',
  findings: 'findings.json',
  reportHtml: 'report.html',
  reportMd: 'report.md',
  card: 'share-card.png',
} as const;

const EVIDENCE_DIRS = ['capture', 'screenshots', 'snapshots', 'handoffs'];
const EVIDENCE_ROOT_FILES = [PATHS.journey, PATHS.run, PATHS.canaries];
export const DERIVED_FILES = [PATHS.findings, PATHS.reportHtml, PATHS.reportMd];

export const LOG_GENESIS = sha256Hex('khara-check request log v1');
export const CHAIN_GENESIS = sha256Hex('khara-check evidence chain v1');

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  schema: 1;
  tool: { name: string; version: string };
  createdAt: string;
  evidence: (ManifestEntry & { chain: string })[];
  /** The last link of the chain. Changing any evidence byte changes this value. */
  seal: string;
  requestLog: { records: number; head: string };
  derived: ManifestEntry[];
}

/** One line per request. Each line carries the hash of the line before it. */
export function encodeRequestLog(records: RequestRecord[]): { text: string; head: string } {
  let prev = LOG_GENESIS;
  const lines: string[] = [];
  for (const record of records) {
    const line = canonicalJson({ ...record, prev });
    lines.push(line);
    prev = sha256Hex(line);
  }
  return { text: lines.join('\n') + (lines.length ? '\n' : ''), head: prev };
}

export function decodeRequestLog(text: string): { records: RequestRecord[]; head: string; brokenAt?: number } {
  let prev = LOG_GENESIS;
  const records: RequestRecord[] = [];
  let brokenAt: number | undefined;
  const lines = text.split('\n').filter((l) => l !== '');
  lines.forEach((line, i) => {
    const parsed = JSON.parse(line) as RequestRecord & { prev: string };
    if (parsed.prev !== prev && brokenAt === undefined) brokenAt = i + 1;
    const { prev: _prev, ...record } = parsed;
    records.push(record);
    prev = sha256Hex(line);
  });
  return { records, head: prev, ...(brokenAt !== undefined ? { brokenAt } : {}) };
}

function listFiles(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.posix.join(base, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

export function evidenceFiles(dir: string): string[] {
  return [
    ...EVIDENCE_ROOT_FILES.filter((f) => existsSync(path.join(dir, f))),
    ...EVIDENCE_DIRS.flatMap((d) => listFiles(path.join(dir, d), d)),
  ].sort();
}

function entry(dir: string, rel: string): ManifestEntry {
  const data = readFileSync(path.join(dir, rel));
  return { path: rel, bytes: data.length, sha256: sha256Hex(data) };
}

export function chainEvidence(entries: ManifestEntry[]): { evidence: Manifest['evidence']; seal: string } {
  let link = CHAIN_GENESIS;
  const evidence = entries.map((e) => {
    link = sha256Hex(`${link}\n${e.path}\n${e.sha256}`);
    return { ...e, chain: link };
  });
  return { evidence, seal: link };
}

export interface EvidenceInput {
  journeyText: string;
  run: RunInfo;
  canaries: Canary[];
  records: RequestRecord[];
  cookies: unknown[];
}

/** Writes the evidence files. Screenshots and snapshots are already in place from the run. */
export function writeEvidence(dir: string, input: EvidenceInput): void {
  mkdirSync(path.join(dir, 'capture'), { recursive: true });
  writeFileSync(path.join(dir, PATHS.journey), input.journeyText);
  writeFileSync(path.join(dir, PATHS.run), prettyCanonicalJson(input.run));
  writeFileSync(path.join(dir, PATHS.canaries), prettyCanonicalJson(input.canaries));
  writeFileSync(path.join(dir, PATHS.requests), encodeRequestLog(input.records).text);
  writeFileSync(path.join(dir, PATHS.cookies), prettyCanonicalJson(input.cookies));
}

export function serializeAnalysis(analysis: Analysis): string {
  return prettyCanonicalJson(analysis);
}

/** Seals the bundle: hashes every evidence file, chains the hashes, records the derived files. */
export function writeManifest(dir: string, run: RunInfo): Manifest {
  const { evidence, seal } = chainEvidence(evidenceFiles(dir).map((f) => entry(dir, f)));
  const log = decodeRequestLog(readFileSync(path.join(dir, PATHS.requests), 'utf8'));
  const manifest: Manifest = {
    schema: 1,
    tool: run.tool,
    createdAt: new Date(run.endedAt).toISOString(),
    evidence,
    seal,
    requestLog: { records: log.records.length, head: log.head },
    derived: DERIVED_FILES.filter((f) => existsSync(path.join(dir, f))).map((f) => entry(dir, f)),
  };
  writeFileSync(path.join(dir, PATHS.manifest), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    path.join(dir, PATHS.seal),
    [
      `khara-check evidence seal`,
      ``,
      `  ${seal}`,
      ``,
      `Journey:  ${run.journeyName}`,
      `Site:     ${run.site.name} (${run.site.origin})`,
      `Captured: ${new Date(run.startedAt).toISOString()} to ${new Date(run.endedAt).toISOString()}`,
      `Files:    ${evidence.length} evidence files, ${log.records.length} recorded requests`,
      ``,
      `This value is a SHA-256 chain over every evidence file in this folder. If one byte of the`,
      `evidence changes, the seal changes. Publishing or timestamping the seal on the day of the`,
      `capture lets anyone confirm later that the evidence has not been edited since.`,
      ``,
      `Check it:  khara-check verify <this folder> --seal ${seal}`,
      ``,
    ].join('\n'),
  );
  return manifest;
}

export interface LoadedBundle {
  dir: string;
  run: RunInfo;
  canaries: Canary[];
  records: RequestRecord[];
  logHead: string;
  logBrokenAt?: number;
}

export function loadBundle(dir: string): LoadedBundle {
  const read = (rel: string): string => {
    try {
      return readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      throw new Error(`${dir} is not a Khara Check evidence bundle: ${rel} is missing`);
    }
  };
  const run = JSON.parse(read(PATHS.run)) as RunInfo;
  const canaries = JSON.parse(read(PATHS.canaries)) as Canary[];
  const log = decodeRequestLog(read(PATHS.requests));
  return {
    dir,
    run,
    canaries,
    records: log.records,
    logHead: log.head,
    ...(log.brokenAt !== undefined ? { logBrokenAt: log.brokenAt } : {}),
  };
}
