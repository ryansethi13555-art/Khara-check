import path from 'node:path';
import { derive, verifyBundle } from '../evidence/derive.js';
import type { Finding, RunInfo, VendorCategory } from '../types.js';

/**
 * Many evidence folders, one picture. Used for three things:
 *  - consent comparisons (the same journey with no choice, "Reject all" and "Accept all"),
 *  - repeat runs (how many of N runs showed each leak: measured, not assumed),
 *  - fleet scorecards (many sites side by side).
 * Every folder is verified before it is counted.
 */

export type Condition = 'no-choice' | 'reject' | 'accept' | 'single';

export interface RunSummary {
  dir: string;
  site: string;
  origin: string;
  journey: string;
  condition: Condition;
  seal: string;
  verified: boolean;
  sandbox: boolean;
  startedAt: number;
  timezone: string;
  leaks: LeakSummary[];
  contacted: number;
}

export interface LeakSummary {
  recipient: string;
  company: string;
  category?: VendorCategory;
  canary: string;
  canaryLabel: string;
  kind: 'plain' | 'encoded' | 'hash' | 'partial';
  /** Consent states in which this leak was seen in this run. */
  states: NonNullable<Finding['consent']>[];
}

const KIND_ORDER = { plain: 0, encoded: 1, hash: 2, partial: 3 } as const;

export function summarizeRun(dir: string): RunSummary {
  const verification = verifyBundle(dir);
  const d = derive(dir);
  const run: RunInfo = d.bundle.run;
  const byKey = new Map<string, LeakSummary>();
  for (const f of d.analysis.leaks) {
    const recipient = f.recipient.product ?? f.recipient.domain;
    const key = `${recipient}\u0000${f.canary}`;
    const canary = d.analysis.canaries.find((c) => c.name === f.canary)!;
    const full = f.sightings.some((s) => s.exactness === 'full');
    const kind = full ? f.strongest : 'partial';
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        recipient,
        company: f.recipient.vendor ?? f.recipient.domain,
        ...(f.recipient.category ? { category: f.recipient.category } : {}),
        canary: f.canary,
        canaryLabel: canary.label,
        kind,
        states: f.consent ? [f.consent] : [],
      });
    } else {
      if (KIND_ORDER[kind] < KIND_ORDER[existing.kind]) existing.kind = kind;
      if (f.consent && !existing.states.includes(f.consent)) existing.states.push(f.consent);
    }
  }
  return {
    dir,
    site: run.site.name,
    origin: run.site.origin,
    journey: run.journeyName,
    condition: run.consent ?? 'single',
    seal: d.seal,
    verified: verification.ok,
    sandbox: run.mode === 'sandbox',
    startedAt: run.startedAt,
    timezone: run.environment.timezone,
    leaks: [...byKey.values()],
    contacted: d.analysis.contacted.length,
  };
}

export interface Cell {
  /** Runs (of this site and condition) in which the recipient received this canary. */
  seen: number;
  runs: number;
  kind: LeakSummary['kind'];
  beforeChoice: boolean;
  afterReject: boolean;
}

export interface SiteBlock {
  site: string;
  origin: string;
  conditions: Condition[];
  runsPer: Record<string, number>;
  canaries: { name: string; label: string }[];
  rows: { recipient: string; company: string; category?: VendorCategory; cells: Record<string, Record<string, Cell>> }[];
  /** Plain-language findings for this site, strongest first. */
  lines: string[];
  companiesTold: number;
  companiesAfterReject: number;
  companiesBeforeChoice: number;
  readable: boolean;
  allVerified: boolean;
  runs: RunSummary[];
}

export interface Comparison {
  title: string;
  kind: 'consent' | 'repeat' | 'fleet';
  sites: SiteBlock[];
  sandbox: boolean;
  totalRuns: number;
}

export const CONDITION_LABEL: Record<Condition, string> = {
  'no-choice': 'Banner ignored',
  reject: 'After "Reject all"',
  accept: 'After "Accept all"',
  single: 'This run',
};

const ORDER: Condition[] = ['no-choice', 'reject', 'accept', 'single'];

function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function compare(summaries: RunSummary[], title?: string): Comparison {
  const bySite = new Map<string, RunSummary[]>();
  // A site served from this machine gets a new port each run, so the port is not part of its identity.
  const keyOf = (s: RunSummary): string => {
    let host = s.origin;
    try {
      host = new URL(s.origin).hostname;
    } catch {
      /* keep the origin */
    }
    return `${s.site}\u0000${host}`;
  };
  for (const s of summaries) bySite.set(keyOf(s), [...(bySite.get(keyOf(s)) ?? []), s]);

  const sites: SiteBlock[] = [...bySite.values()].map((runs) => {
    const conditions = ORDER.filter((c) => runs.some((r) => r.condition === c));
    const runsPer: Record<string, number> = {};
    for (const c of conditions) runsPer[c] = runs.filter((r) => r.condition === c).length;
    const canaryMap = new Map<string, string>();
    for (const r of runs) for (const l of r.leaks) canaryMap.set(l.canary, l.canaryLabel);
    const canaries = [...canaryMap].map(([name, label]) => ({ name, label }));

    const rowMap = new Map<string, SiteBlock['rows'][number]>();
    for (const r of runs) {
      for (const l of r.leaks) {
        let row = rowMap.get(l.recipient);
        if (!row) {
          row = { recipient: l.recipient, company: l.company, ...(l.category ? { category: l.category } : {}), cells: {} };
          rowMap.set(l.recipient, row);
        }
        const byCanary = (row.cells[r.condition] ??= {});
        const cell = (byCanary[l.canary] ??= { seen: 0, runs: runsPer[r.condition]!, kind: l.kind, beforeChoice: false, afterReject: false });
        cell.seen++;
        if (KIND_ORDER[l.kind] < KIND_ORDER[cell.kind]) cell.kind = l.kind;
        if (l.states.includes('before-choice')) cell.beforeChoice = true;
        if (l.states.includes('after-reject')) cell.afterReject = true;
      }
    }
    const rows = [...rowMap.values()].sort((a, b) => {
      const score = (row: typeof a): number =>
        Object.values(row.cells).reduce((n, byCanary) => n + Object.values(byCanary).reduce((m, c) => m + c.seen * (4 - KIND_ORDER[c.kind]), 0), 0);
      return score(b) - score(a) || a.recipient.localeCompare(b.recipient);
    });

    const companies = (pred: (c: Cell) => boolean): string[] =>
      [...new Set(rows.filter((row) => Object.values(row.cells).some((bc) => Object.values(bc).some(pred))).map((row) => row.company))];
    const told = companies(() => true);
    const afterReject = companies((c) => c.afterReject);
    const beforeChoice = companies((c) => c.beforeChoice);

    const lines: string[] = [];
    const labelsWhere = (pred: (c: Cell) => boolean): string[] =>
      canaries.filter((cn) => rows.some((row) => Object.values(row.cells).some((bc) => bc[cn.name] && pred(bc[cn.name]!)))).map((cn) => `the ${cn.label}`);
    if (afterReject.length) {
      lines.push(`Even after the customer pressed "Reject all", ${list(labelsWhere((c) => c.afterReject))} went to ${list(afterReject)}.`);
    }
    if (beforeChoice.length) {
      lines.push(`Before the customer answered the consent banner, ${list(labelsWhere((c) => c.beforeChoice))} had already gone to ${list(beforeChoice)}.`);
    }
    if (told.length && !afterReject.length && !beforeChoice.length) {
      lines.push(`${list(labelsWhere(() => true)).replace(/^./, (x) => x.toUpperCase())} went to ${list(told)}.`);
    }
    const repeats = Math.max(...Object.values(runsPer));
    if (repeats > 1) {
      const steady = rows.filter((row) => Object.values(row.cells).some((bc) => Object.values(bc).some((c) => c.seen === c.runs)));
      lines.push(`Across ${repeats} repeat runs, ${steady.length} of ${rows.length} ${rows.length === 1 ? 'recipient was' : 'recipients were'} seen in every run.`);
    }
    if (!told.length) lines.push('Nothing the customer typed left the site in any run.');

    return {
      site: runs[0]!.site,
      origin: runs[0]!.origin,
      conditions,
      runsPer,
      canaries,
      rows,
      lines,
      companiesTold: told.length,
      companiesAfterReject: afterReject.length,
      companiesBeforeChoice: beforeChoice.length,
      readable: rows.some((row) => Object.values(row.cells).some((bc) => Object.values(bc).some((c) => c.kind === 'plain'))),
      allVerified: runs.every((r) => r.verified),
      runs: runs.sort((a, b) => a.startedAt - b.startedAt),
    };
  });

  sites.sort((a, b) => b.companiesAfterReject - a.companiesAfterReject || b.companiesTold - a.companiesTold || a.site.localeCompare(b.site));
  const kind: Comparison['kind'] = sites.length > 1 ? 'fleet' : sites[0]?.conditions.some((c) => c !== 'single') ? 'consent' : 'repeat';
  return {
    title:
      title ??
      (kind === 'fleet' ? `${sites.length} sites compared` : kind === 'consent' ? `${sites[0]!.site}: does "Reject all" work?` : `${sites[0]?.site ?? 'Runs'}: repeat runs`),
    kind,
    sites,
    sandbox: summaries.every((s) => s.sandbox),
    totalRuns: summaries.length,
  };
}

export function relativeDir(from: string, dir: string): string {
  return path.relative(from, dir) || '.';
}
