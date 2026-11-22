import { CSS, esc } from '../report/html.js';
import { formatWhen } from '../report/model.js';
import { CONDITION_LABEL, relativeDir, type Cell, type Comparison, type SiteBlock } from './compare.js';

const KIND_LABEL = { plain: 'Readable', encoded: 'Encoded', hash: 'Hashed', partial: 'In part' } as const;

const EXTRA_CSS = `
.cell{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.cell .k{font-size:12.5px;color:var(--muted)}
.flag{display:inline-block;font:600 11px/1 var(--sans);letter-spacing:.04em;text-transform:uppercase;padding:5px 7px;border-radius:6px;background:var(--red);color:#fff;margin-top:2px}
.flag.pre{background:var(--amber);color:#fff}
.sitehead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.sitehead small{color:var(--muted);font:13px var(--mono)}
.lines{margin:10px 0 22px;padding:0;list-style:none;display:grid;gap:8px}
.lines li{font:18px/1.45 var(--serif)}
.score td{white-space:nowrap}
.score th{white-space:normal}
.score td:first-child{white-space:normal}
.big{font:700 28px/1 var(--serif)}
.big.zero{color:var(--green)}
.big.bad{color:var(--red)}
.runs{font-size:13.5px;color:var(--muted)}
.runs code{font-size:12px}
`;

function cellHtml(cell: Cell | undefined, label: string, showCounts: boolean): string {
  if (!cell) return '';
  return `<div class="cell"><span class="pill ${cell.kind}">${esc(label)}: ${KIND_LABEL[cell.kind]}</span>${
    showCounts ? `<span class="k">${cell.seen} of ${cell.runs} ${cell.runs === 1 ? 'run' : 'runs'}</span>` : ''
  }${cell.afterReject ? '<span class="flag">after reject</span>' : ''}${cell.beforeChoice ? '<span class="flag pre">before choice</span>' : ''}</div>`;
}

function siteTable(site: SiteBlock): string {
  const showCounts = Object.values(site.runsPer).some((n) => n > 1);
  return `<div class="grid-wrap"><table class="grid">
    <thead><tr><th>Sent to</th>${site.conditions.map((c) => `<th>${esc(CONDITION_LABEL[c])}${site.runsPer[c]! > 1 ? ` <span class="none">(${site.runsPer[c]} runs)</span>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${site.rows
      .map(
        (row) => `<tr><td class="who"><b>${esc(row.recipient)}</b>${row.company !== row.recipient ? `<span>${esc(row.company)}</span>` : ''}</td>${site.conditions
          .map((c) => {
            const cells = site.canaries.map((cn) => cellHtml(row.cells[c]?.[cn.name], cn.label, showCounts)).filter(Boolean);
            return `<td>${cells.length ? cells.join('') : '<span class="none">Nothing planted</span>'}</td>`;
          })
          .join('')}</tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

export function renderComparisonHtml(cmp: Comparison, outDir: string): string {
  const fleet = cmp.kind === 'fleet';
  const first = cmp.sites[0];
  const hero =
    cmp.kind === 'consent' && first
      ? first.companiesAfterReject
        ? `"Reject all" did not stop <em>${first.companiesAfterReject} ${first.companiesAfterReject === 1 ? 'company' : 'companies'}</em>.`
        : first.companiesBeforeChoice
          ? `<em>${first.companiesBeforeChoice} ${first.companiesBeforeChoice === 1 ? 'company' : 'companies'}</em> got data before the customer chose.`
          : '"Reject all" was respected in these runs.'
      : fleet
        ? `${cmp.sites.filter((s) => s.companiesTold).length} of ${cmp.sites.length} sites told other companies what the customer typed.`
        : esc(first?.lines[0] ?? '');

  const scorecard = fleet
    ? `<section><h2>Scorecard</h2><p class="sub">One row per site, from ${cmp.totalRuns} verified ${cmp.totalRuns === 1 ? 'run' : 'runs'}. Sites that kept sending data after "Reject all" come first.</p>
  <div class="grid-wrap"><table class="grid score"><thead><tr><th>Site</th><th>Companies told</th><th>After "Reject all"</th><th>Before any choice</th><th>Readable text</th><th>Evidence</th></tr></thead><tbody>
  ${cmp.sites
    .map(
      (s) => `<tr><td class="who"><b><a href="#${slug(s.site)}" style="color:inherit">${esc(s.site)}</a></b><span>${esc(s.origin)}</span></td>
      <td><span class="big ${s.companiesTold ? 'bad' : 'zero'}">${s.companiesTold}</span></td>
      <td>${s.conditions.includes('reject') ? `<span class="big ${s.companiesAfterReject ? 'bad' : 'zero'}">${s.companiesAfterReject}</span>` : '<span class="none">Not tested</span>'}</td>
      <td>${s.conditions.some((c) => c !== 'single') ? `<span class="big ${s.companiesBeforeChoice ? 'bad' : 'zero'}">${s.companiesBeforeChoice}</span>` : '<span class="none">Not tested</span>'}</td>
      <td>${s.readable ? '<span class="pill plain">Yes</span>' : '<span class="none">No</span>'}</td>
      <td>${s.allVerified ? '<span class="ok">✓ Verified</span>' : '<span class="flag">Not verified</span>'}</td></tr>`,
    )
    .join('')}
  </tbody></table></div></section>`
    : '';

  const blocks = cmp.sites
    .map(
      (s) => `<section id="${slug(s.site)}">
  <div class="sitehead"><h2>${esc(s.site)}</h2><small>${esc(s.origin)}</small></div>
  <ul class="lines">${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  ${s.rows.length ? siteTable(s) : ''}
  <p class="runs" style="margin-top:16px">${s.runs.length} ${s.runs.length === 1 ? 'run' : 'runs'}, each with its own sealed evidence folder and full report: ${s.runs
    .map((r) => `<a href="${esc(relativeDir(outDir, r.dir))}/report.html">${esc(CONDITION_LABEL[r.condition])}</a> <code>${esc(r.seal.slice(0, 12))}</code>${r.verified ? '' : ' <span class="flag">not verified</span>'}`)
    .join(' · ')}</p>
</section>`,
    )
    .join('\n');

  const when = cmp.sites[0]?.runs[0] ? formatWhen(cmp.sites[0].runs[0].startedAt, cmp.sites[0].runs[0].timezone) : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cmp.title)} | Khara Check</title>
<style>${CSS}${EXTRA_CSS}</style>
</head>
<body>
<div class="top"><div class="in"><span class="mark">Khara <b>Check</b></span><small>${cmp.totalRuns} sealed ${cmp.totalRuns === 1 ? 'run' : 'runs'}</small></div></div>
<div class="in">
<div class="hero">
  <p class="eyebrow">${fleet ? 'Scorecard' : cmp.kind === 'consent' ? 'Consent test' : 'Repeat runs'} · ${esc(cmp.title)}</p>
  <h1>${hero}</h1>
  <ul class="meta"><li><b>Runs</b> ${cmp.totalRuns}, every one verified before it was counted</li>${when ? `<li><b>First run</b> ${esc(when)}</li>` : ''}</ul>
  ${cmp.sandbox ? '<p class="notice"><b>Practice runs.</b> These ran in Khara Check\'s sandbox against a site served from this machine. Nothing reached any real company.</p>' : ''}
  ${cmp.kind !== 'repeat' ? '<p class="sub" style="margin:22px 0 0">How it works: the same journey runs with the consent banner ignored, answered with "Reject all", and answered with "Accept all". Each request is tagged with the consent state at the moment it left the browser.</p>' : ''}
</div>
${scorecard}
${blocks}
<footer>Made with Khara Check. Each run is one observation; counts show how often a leak was seen, not how often it happens.</footer>
</div>
</body>
</html>
`;
}

export function renderComparisonMarkdown(cmp: Comparison, outDir: string): string {
  const out: string[] = [`# ${cmp.title}`, ''];
  if (cmp.sandbox) out.push('> Practice runs in Khara Check\'s sandbox. Nothing reached any real company.', '');
  for (const s of cmp.sites) {
    out.push(`## ${s.site}`, '', ...s.lines.map((l) => `- ${l}`), '');
    if (s.rows.length) {
      out.push(`| Sent to | ${s.conditions.map((c) => CONDITION_LABEL[c]).join(' | ')} |`, `| --- | ${s.conditions.map(() => '---').join(' | ')} |`);
      for (const row of s.rows) {
        out.push(
          `| ${row.recipient} | ${s.conditions
            .map((c) =>
              s.canaries
                .map((cn) => {
                  const cell = row.cells[c]?.[cn.name];
                  if (!cell) return '';
                  const flags = [cell.afterReject ? 'after reject' : '', cell.beforeChoice ? 'before choice' : ''].filter(Boolean).join(', ');
                  return `${cn.label}: ${KIND_LABEL[cell.kind]} (${cell.seen}/${cell.runs}${flags ? `, ${flags}` : ''})`;
                })
                .filter(Boolean)
                .join('; ') || 'nothing planted',
            )
            .join(' | ')} |`,
        );
      }
      out.push('');
    }
    out.push('Evidence:', ...s.runs.map((r) => `- ${CONDITION_LABEL[r.condition]}: \`${relativeDir(outDir, r.dir)}\` seal \`${r.seal}\`${r.verified ? '' : ' (NOT verified)'}`), '');
  }
  return out.join('\n');
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
