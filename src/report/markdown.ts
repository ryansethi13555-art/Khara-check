import type { ReportModel } from './model.js';

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const cell = (t: string): string => t.replace(/\|/g, '\\|');

export function renderMarkdown(m: ReportModel): string {
  const { run, analysis } = m;
  const out: string[] = [];
  out.push(`# ${m.headline}`, '', m.subhead, '');
  out.push(`- Site: ${run.site.name} (${run.site.origin})`);
  out.push(`- Journey: ${run.journeyName}`);
  out.push(`- When: ${m.when}`);
  out.push(`- Requests recorded: ${analysis.totals.requests}. Outside services contacted: ${analysis.contacted.length}.`);
  out.push(`- Evidence seal: \`${m.seal}\``, '');
  if (m.stopped) {
    out.push(`> **The journey did not finish.** It stopped after "${m.stopped.after}": ${m.stopped.reason} Findings cover only the steps that ran.`, '');
  }
  if (run.capture === 'imported') {
    out.push('> **Recorded by a person, imported from a HAR file.** A person did this journey in their own browser and saved the network log from its developer tools. Khara Check did not watch the recording: the seal proves nothing has changed since the file was imported, and the planted values are the ones the person says they typed.', '');
  }
  if (run.capture === 'attached') {
    out.push('> **Done by a person.** A person did this journey by hand in their own browser. Khara Check only listened to the browser\'s network log.', '');
  }
  if (m.sandbox) {
    out.push(
      '> **Practice run.** This ran in Khara Check\'s sandbox against a site served from this machine. Requests to outside companies were recorded and then answered locally. Nothing reached any real company.',
      '',
    );
  }

  if (m.groups.length) {
    out.push('## Who received what', '');
    out.push(`| Sent to | ${analysis.canaries.map((c) => cap(c.label)).join(' | ')} |`);
    out.push(`| --- | ${analysis.canaries.map(() => '---').join(' | ')} |`);
    for (const row of m.grid) {
      const name = row.vendorLine ? `${row.recipient} (${row.vendorLine})` : row.recipient;
      out.push(`| ${cell(name)} | ${row.cells.map((c) => c?.label ?? 'Not seen').join(' | ')} |`);
    }
    out.push('', 'Readable: plain text. Encoded: wrapped, but readable once unwrapped. Hashed: scrambled into a fingerprint the receiver can match against people it already knows.', '');

    out.push('## In plain words', '');
    for (const g of m.groups) out.push(`- ${g.sentence} ${g.detail} (proof: ${g.findings.map((f) => f.requestId).join(', ')})`);
    out.push('');
  }

  out.push('## What the customer did', '');
  for (const s of run.steps) {
    const hits = [...new Set(m.groups.filter((g) => g.findings[0]!.step === s.index).map((g) => g.recipient))];
    out.push(`${s.index + 1}. ${s.label}${hits.length ? `. Then data went out to **${hits.join(', ')}**` : ''}${s.ok ? '' : `. FAILED: ${s.error}`}`);
    for (const h of (run.handoffs ?? []).filter((x) => x.index === s.index)) {
      out.push(`   - ${h.ok ? 'Handed to a person' : 'Stopped'}: ${h.label}${h.error ? `. ${h.error}` : ''}`);
    }
  }
  out.push('');

  if (m.sst.length) {
    out.push('## Server-side tagging', '');
    out.push('Detected with the method of Moti et al., "The Bitter Pill" (section 3.4): the Google tag\'s parameters stay the same when the address changes. The browser sees only the first step, so the companies the server passes the data to are not in this report.', '');
    for (const e of m.sst) out.push(`- **${e.host}** ${e.paths.join(', ')} (${e.confidence}, ${e.requestIds.join(', ')}): ${e.sentence}${e.addresses.length ? ` Server address: ${e.addresses.join(', ')}.` : ''}`);
    out.push('');
  }

  out.push('## What stayed put', '');
  if (m.collectors.length) {
    out.push('Sent to a data collector at the site\'s own address (the browser cannot see where it goes next):', '');
    for (const c of m.collectors) out.push(`- ${c.host}, shaped like a ${c.name} endpoint: ${c.labels.join(', ')} (${c.requestIds.join(', ')})`);
    out.push('');
  }
  if (m.firstParty.length) {
    out.push('Sent to the site itself, which is expected:', '');
    for (const f of m.firstParty) out.push(`- ${cap(f.canary.label)}: ${f.ways.join(', ')} (${f.requests} ${f.requests === 1 ? 'request' : 'requests'})`);
    out.push('');
  }
  if (m.quiet.length) {
    out.push('Contacted, but sent nothing planted:', '');
    for (const q of m.quiet) out.push(`- ${q.name} (${q.category}, ${q.requests} ${q.requests === 1 ? 'request' : 'requests'})`);
    out.push('');
  }

  if (m.questions.length) {
    out.push('## Questions this raises', '');
    out.push("Under India's Digital Personal Data Protection Act, 2023. These are questions for the site to answer, not conclusions.", '');
    m.questions.forEach((q, i) => out.push(`${i + 1}. ${q.question} (${q.basis})`));
    out.push('');
  }

  out.push('## What this report can and cannot say', '');
  out.push('It can say that these exact requests were made by this page in this run, and that the planted values were inside them.');
  out.push('It cannot say that the site always does this, what the receiving company did with the data, or that nothing else leaked.', '');

  if (m.groups.length) {
    out.push('## The proof', '');
    for (const g of m.groups) {
      out.push(`### ${g.recipient}: ${g.canary.label} (${g.cell.label.toLowerCase()})`, '');
      for (const f of g.findings) {
        out.push(`- **${f.requestId}** ${f.method} to \`${f.recipient.host}\`${f.decoded?.eventName ? `, event \`${f.decoded.eventName}\`` : ''}`);
        for (const s of f.sightings) {
          const where = s.surface === 'header' ? `header "${s.surfaceName}"` : s.surface;
          const chain = s.chain.filter(Boolean).length ? ` Steps: ${s.chain.filter(Boolean).join(' → ')}.` : '';
          out.push(`  - In the ${where}${s.field ? `, field \`${s.field}\`` : ''}: ${s.formLabel}.${chain}`);
        }
      }
      out.push('');
    }
  }

  out.push('## Check it yourself', '');
  out.push('```', 'khara-check verify <this folder>', '```', '');
  out.push('Planted values:', '');
  for (const c of analysis.canaries) out.push(`- ${cap(c.label)}: \`${c.value}\``);
  out.push('', `Captured with ${run.tool.name} ${run.tool.version}, ${run.environment.browser} ${run.environment.browserVersion}. Findings describe this run only.`, '');
  return out.join('\n');
}
