import type { Verification } from '../evidence/derive.js';
import type { ReportModel } from './model.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');

const MARK = { plain: 'READABLE', encoded: 'ENCODED', hash: 'HASHED', partial: 'IN PART' } as const;

export function summaryText(m: ReportModel): string {
  const lines: string[] = ['', bold(m.headline), dim(m.subhead), ''];
  if (m.groups.length) {
    const width = Math.max(...m.grid.map((r) => r.recipient.length), 8);
    for (const row of m.grid) {
      const cells = m.analysis.canaries
        .map((c, i) => {
          const cell = row.cells[i];
          if (!cell) return null;
          const tag = MARK[cell.kind];
          return `${c.label}: ${cell.kind === 'plain' ? red(tag) : yellow(tag)}`;
        })
        .filter(Boolean)
        .join(dim('  ·  '));
      lines.push(`  ${row.recipient.padEnd(width)}  ${cells}${row.refererOnly ? dim('  (Referer header only)') : ''}${row.lookalike ? dim("  (name like the site's own, not counted)") : ''}`);
    }
    lines.push('');
  }
  for (const e of m.sst) lines.push(yellow(`  Google server-side tagging (${e.confidence}): ${e.host}${e.paths[0] ?? ''} received Google Analytics hits (${e.measurementIds.join(', ')})`));
  for (const c of m.collectors) lines.push(yellow(`  Collector at the site's own address: ${c.host} (${c.name}) got ${c.labels.join(', ')}`));
  if (m.stopped) lines.push(red(`  The journey stopped after "${m.stopped.after}". Findings cover only the steps that ran.`));
  if (m.quiet.length) lines.push(dim(`  Contacted, sent nothing planted: ${m.quiet.map((q) => q.name).join(', ')}`));
  if (m.firstParty.length) lines.push(dim(`  Also sent to the site itself, as expected: ${m.firstParty.map((f) => f.canary.label).join(', ')}`));
  if (m.sandbox) lines.push(dim('  Practice run: nothing reached any real company.'));
  return lines.join('\n');
}

export function verificationText(v: Verification): string {
  const lines = v.checks.map((c) => `  ${c.ok ? green('✓') : red('✗')} ${bold(c.name)}  ${dim(c.detail)}`);
  lines.push('', v.ok ? green('Verified. The evidence is intact and the findings reproduce from it.') : red('NOT verified. See the failed checks above.'));
  return lines.join('\n');
}
