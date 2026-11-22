import type { Analysis, Canary, Finding, RunInfo, Sighting, VendorCategory } from '../types.js';

/** Everything the HTML, Markdown and terminal reports need, worked out once. */
export interface ReportModel {
  run: RunInfo;
  analysis: Analysis;
  seal: string;
  sandbox: boolean;
  headline: string;
  subhead: string;
  companies: string[];
  groups: LeakGroup[];
  /** Rows of the "who received what" grid. */
  grid: { recipient: string; vendorLine: string; category: string; cells: (Cell | null)[] }[];
  firstParty: { canary: Canary; requests: number; ways: string[] }[];
  quiet: { name: string; category: string; requests: number; purpose?: string }[];
  questions: { question: string; basis: string }[];
  when: string;
  duration: string;
}

export interface Cell {
  kind: 'plain' | 'encoded' | 'hash' | 'partial';
  label: string;
}

/** One recipient receiving one canary, across however many requests. */
export interface LeakGroup {
  id: string;
  canary: Canary;
  recipient: string;
  company: string;
  identified: boolean;
  category: string;
  findings: Finding[];
  cell: Cell;
  sentence: string;
  detail: string;
  stepLabel: string;
  seconds: string;
}

const CATEGORY: Record<VendorCategory, string> = {
  advertising: 'Advertising',
  analytics: 'Analytics',
  'session-replay': 'Session recording',
  'customer-engagement': 'Marketing messages',
  attribution: 'Ad attribution',
  'tag-manager': 'Tag manager',
  other: 'Other',
};

const CELL_LABEL: Record<Cell['kind'], string> = {
  plain: 'Readable',
  encoded: 'Encoded',
  hash: 'Hashed',
  partial: 'In part',
};

export function recipientName(f: { recipient: Finding['recipient'] }): string {
  return f.recipient.product ?? f.recipient.domain;
}

function companyName(f: Finding): string {
  return f.recipient.vendor ?? f.recipient.domain;
}

function cellOf(findings: Finding[]): Cell {
  const sightings = findings.flatMap((f) => f.sightings);
  const full = sightings.filter((s) => s.exactness === 'full');
  const kind: Cell['kind'] = !full.length
    ? 'partial'
    : full.some((s) => s.formKind === 'plain')
      ? 'plain'
      : full.some((s) => s.formKind === 'encoded')
        ? 'encoded'
        : 'hash';
  return { kind, label: CELL_LABEL[kind] };
}

export function seconds(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)} seconds`;
  return `${(ms / 1000).toFixed(1)} seconds`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function quote(canary: Canary): string {
  return canary.type === 'search-term' || canary.type === 'text' ? `the ${canary.label} "${canary.value}"` : `the ${canary.label}`;
}

function howPhrase(cell: Cell, best: Sighting): string {
  switch (cell.kind) {
    case 'plain':
      return 'as readable text';
    case 'encoded':
      return `${best.formLabel.replace(' (readable once decoded)', '')}, readable once decoded`;
    case 'hash': {
      const algorithm = /SHA-256|SHA-1|MD5/.exec(best.formLabel)?.[0] ?? 'a';
      return `as a ${algorithm} hash`;
    }
    case 'partial':
      return 'in part (only the unique marker was found)';
  }
}

function bestSighting(findings: Finding[]): Sighting {
  const order = { plain: 0, encoded: 1, hash: 2 } as const;
  return findings
    .flatMap((f) => f.sightings)
    .sort(
      (a, b) =>
        (a.exactness === 'full' ? 0 : 1) - (b.exactness === 'full' ? 0 : 1) ||
        // A field named for the value ("search text") explains more than one that merely contains it ("page address").
        Number(/contains it/.test(a.meaning ?? 'contains it')) - Number(/contains it/.test(b.meaning ?? 'contains it')) ||
        order[a.formKind] - order[b.formKind],
    )[0]!;
}

export function formatWhen(ms: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(ms));
    return parts.replace(' at ', ', ');
  } catch {
    return new Date(ms).toISOString();
  }
}

export function buildModel(run: RunInfo, analysis: Analysis, seal: string): ReportModel {
  const sandbox = run.mode === 'sandbox';
  const canaryByName = new Map(analysis.canaries.map((c) => [c.name, c]));

  // Group findings: one group per (recipient, canary).
  const byKey = new Map<string, Finding[]>();
  for (const f of analysis.leaks) {
    const key = `${recipientName(f)}\u0000${f.canary}`;
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  const groups: LeakGroup[] = [...byKey.values()].map((findings, i) => {
    const first = findings[0]!;
    const canary = canaryByName.get(first.canary)!;
    const cell = cellOf(findings);
    const best = bestSighting(findings);
    const company = companyName(first);
    const name = recipientName(first);
    const identified = Boolean(first.recipient.vendor);
    const who = identified
      ? company === name
        ? company
        : `${company} (${name})`
      : `${first.recipient.host}, a company Khara Check does not recognise`;
    const step = run.steps[first.step];
    const stepLabel = step?.label ?? 'the page loaded';
    const verb =
      first.delivery === 'sandboxed'
        ? `The page tried to send ${quote(canary)} to ${who}`
        : first.delivery === 'delivered'
          ? `${cap(quote(canary))} was sent to ${who}`
          : `The page tried to send ${quote(canary)} to ${who}, but the request did not complete`;
    const sentence = `${verb} ${howPhrase(cell, best)}, ${seconds(first.msAfterStep)} after the step "${stepLabel}".`;
    const where = best.meaning
      ? `It travelled as ${best.meaning}.`
      : best.field
        ? `It travelled in the field "${best.field}".`
        : `It travelled in the ${best.surface === 'url' ? 'address of the request' : best.surface}.`;
    const times = findings.length > 1 ? ` Seen in ${findings.length} requests.` : '';
    return {
      id: `G${String(i + 1).padStart(2, '0')}`,
      canary,
      recipient: name,
      company,
      identified,
      category: first.recipient.category ? CATEGORY[first.recipient.category] : 'Not identified',
      findings,
      cell,
      sentence,
      detail: where + times,
      stepLabel,
      seconds: seconds(first.msAfterStep),
    };
  });

  // Identified companies first, then the most exposed: readable beats encoded beats hashed.
  const weight = { plain: 3, encoded: 2, hash: 1, partial: 0 } as const;
  const score = (r: string): number =>
    groups.filter((g) => g.recipient === r).reduce((sum, g) => sum + 10 + weight[g.cell.kind], 0);
  const recipients = [...new Set(groups.map((g) => g.recipient))].sort(
    (a, b) =>
      Number(groups.find((g) => g.recipient === b)!.identified) - Number(groups.find((g) => g.recipient === a)!.identified) ||
      score(b) - score(a),
  );
  const companies = [...new Set(recipients.map((r) => groups.find((g) => g.recipient === r)!.company))];
  const typed = list(analysis.canaries.filter((c) => groups.some((g) => g.canary.name === c.name)).map((c) => `the ${c.label}`));

  let headline: string;
  let subhead: string;
  if (!groups.length) {
    headline = 'Nothing the customer typed left the site in this run.';
    subhead = analysis.contacted.length
      ? `${analysis.contacted.length} outside ${analysis.contacted.length === 1 ? 'service was' : 'services were'} contacted, but none of them received a planted value.`
      : 'No outside company was contacted at all.';
  } else {
    const n = companies.length;
    headline = sandbox
      ? `This page tried to tell ${n} ${n === 1 ? 'company' : 'companies'} what the customer typed.`
      : `${n} ${n === 1 ? 'company was' : 'companies were'} sent what the customer typed.`;
    subhead = `${cap(typed)} ${sandbox ? 'went out' : 'went'} to ${list(companies)}.`;
  }

  const grid = recipients.map((recipient) => {
    const mine = groups.filter((g) => g.recipient === recipient);
    const g0 = mine[0]!;
    return {
      recipient,
      vendorLine: g0.identified ? [g0.company === recipient ? '' : g0.company, g0.category].filter(Boolean).join(' · ') : 'Company not identified',
      category: g0.category,
      cells: analysis.canaries.map((c) => mine.find((g) => g.canary.name === c.name)?.cell ?? null),
    };
  });

  const firstParty = analysis.canaries
    .map((canary) => {
      const mine = analysis.firstParty.filter((f) => f.canary === canary.name);
      const ways = [
        ...new Set(
          mine.flatMap((f) =>
            f.sightings.map((s) =>
              s.surface === 'url'
                ? 'in the page address'
                : s.surface === 'header'
                  ? `in the ${s.surfaceName === 'referer' ? 'Referer' : s.surfaceName} header`
                  : s.surface === 'body'
                    ? 'in data posted to the site'
                    : 'over a live connection',
            ),
          ),
        ),
      ];
      return { canary, requests: mine.length, ways };
    })
    .filter((x) => x.requests > 0);

  const quiet = analysis.contacted
    .filter((c) => !c.receivedCanary)
    .map((c) => ({
      name: c.recipient.product
        ? c.recipient.product.startsWith(c.recipient.vendor ?? '\u0000')
          ? c.recipient.product
          : `${c.recipient.vendor} ${c.recipient.product}`
        : c.recipient.domain,
      category: c.recipient.category ? CATEGORY[c.recipient.category] : 'Not identified',
      requests: c.requests,
    }));

  const questions = buildQuestions(groups, companies);

  return {
    run,
    analysis,
    seal,
    sandbox,
    headline,
    subhead,
    companies,
    groups,
    grid,
    firstParty,
    quiet,
    questions,
    when: formatWhen(run.startedAt, run.environment.timezone),
    duration: seconds(run.endedAt - run.startedAt),
  };
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Questions under India's Digital Personal Data Protection Act, 2023.
 * They are questions for the site to answer, never conclusions: a capture shows what was
 * sent, not what the customer was told or what contracts exist.
 */
function buildQuestions(groups: LeakGroup[], companies: string[]): ReportModel['questions'] {
  if (!groups.length) return [];
  const data = list([...new Set(groups.map((g) => `the ${g.canary.label}`))]);
  const who = list(companies);
  const ads = [...new Set(groups.filter((g) => g.category === 'Advertising').map((g) => g.company))];
  const hashed = groups.some((g) => g.cell.kind === 'hash');
  const out: ReportModel['questions'] = [
    {
      question: `Was the customer told, in plain words and before it happened, that ${data} would be shared with ${who}, and for what purpose?`,
      basis: 'Notice: section 5',
    },
    {
      question: 'Did the customer agree to this through a clear action of their own, and could they have said no and still used the site?',
      basis: 'Consent: section 6(1)',
    },
  ];
  if (ads.length) {
    out.push({
      question: `Is sending ${data} to ${list(ads)}, whose business is advertising, necessary for what the customer came to do?`,
      basis: 'Purpose limitation: section 6(1)',
    });
  }
  out.push({
    question: `Does the site have a contract with each of these companies that covers this data and what they may do with it?`,
    basis: 'Data processors: section 8(2)',
  });
  if (hashed) {
    out.push({
      question:
        'The email or phone number was hashed before it was sent. A hash still singles out one person, and the receiving company can match it to accounts it already holds. Is the customer told that this matching happens?',
      basis: 'Notice and consent: sections 5 and 6',
    });
  }
  out.push(
    {
      question: 'Could this customer have been a child? The Act restricts tracking, behavioural monitoring and targeted advertising directed at children.',
      basis: 'Children: section 9(3)',
    },
    {
      question: 'If the customer withdraws consent or asks for erasure, does the request reach the companies that received the data?',
      basis: 'Withdrawal and erasure: sections 6(4), 6(6) and 12',
    },
  );
  return out;
}
