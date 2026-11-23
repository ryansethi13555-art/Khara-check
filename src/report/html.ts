import type { Finding, Sighting } from '../types.js';
import type { Cell, LeakGroup, ReportModel } from './model.js';
import { seconds } from './model.js';

export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function clock(ms: number, timezone: string): string {
  try {
    const t = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
    return `${t}.${String(ms % 1000).padStart(3, '0')}`;
  } catch {
    return new Date(ms).toISOString().slice(11, 23);
  }
}

export const CSS = `
:root{--paper:#faf8f4;--card:#fff;--ink:#17130f;--muted:#6d665b;--rule:#e5dfd4;--soft:#f3efe7;
--red:#c4261d;--red-bg:#fdeceA;--amber:#9a5b00;--amber-bg:#fff3d6;--orange:#b84a08;--orange-bg:#ffe9d9;--green:#1c7448;--green-bg:#e6f4ec;
--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{--paper:#131110;--card:#1c1917;--ink:#f2ede4;--muted:#a39b8e;--rule:#322d27;--soft:#221f1b;
--red:#ff7a6e;--red-bg:#3a1512;--amber:#f0b44a;--amber-bg:#35270a;--orange:#ff9a57;--orange-bg:#3a1d0a;--green:#62c794;--green-bg:#10291c}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
.top{background:#0f0d0b;color:#f4efe6}
.top .in{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:14px 24px}
.mark{font:700 19px/1 var(--serif);letter-spacing:.01em}
.mark b{font-weight:700;color:#ff6b5e}
.top small{font:12px/1.2 var(--mono);opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.in{max-width:900px;margin:0 auto;padding:0 24px}
.hero{padding:56px 0 40px;border-bottom:1px solid var(--rule)}
.eyebrow{font:600 12px/1.4 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 18px}
h1{font:700 clamp(30px,5.2vw,50px)/1.1 var(--serif);letter-spacing:-.015em;margin:0 0 18px;text-wrap:balance}
h1 em{font-style:normal;color:var(--red)}
.lede{font:19px/1.5 var(--serif);color:var(--ink);margin:0 0 26px;max-width:42em;text-wrap:pretty}
.meta{display:flex;flex-wrap:wrap;gap:8px 28px;font-size:14px;color:var(--muted);margin:0;padding:0;list-style:none}
.meta b{color:var(--ink);font-weight:600}
.notice.person{border-left-color:var(--green);background:var(--green-bg)}
.notice{margin:28px 0 0;padding:14px 18px;border-radius:10px;background:var(--amber-bg);color:var(--ink);font-size:15px;border-left:4px solid var(--amber)}
section{padding:44px 0;border-bottom:1px solid var(--rule)}
h2{font:700 26px/1.2 var(--serif);letter-spacing:-.01em;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 24px;max-width:46em}
table{border-collapse:collapse;width:100%}
.grid{background:var(--card);border:1px solid var(--rule);border-radius:14px;overflow:hidden}
.grid th,.grid td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--rule);vertical-align:middle}
.grid tr:last-child td{border-bottom:0}
.grid thead th{font:600 12px/1.3 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);background:var(--soft)}
.grid td.who b{display:block;font-size:16px;overflow-wrap:anywhere}
.grid td.who span{font-size:13px;color:var(--muted)}
.pill{display:inline-block;font:600 13px/1 var(--sans);padding:7px 11px;border-radius:999px;white-space:nowrap}
.pill.plain{background:var(--red-bg);color:var(--red)}
.pill.encoded{background:var(--orange-bg);color:var(--orange)}
.pill.hash,.pill.partial{background:var(--amber-bg);color:var(--amber)}
.none{color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:8px 22px;margin:16px 0 0;padding:0;list-style:none;font-size:13.5px;color:var(--muted)}
.legend .pill{margin-right:6px;padding:4px 8px;font-size:11.5px}
.plainwords{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.plainwords li{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:18px 20px;border-left:4px solid var(--red)}
.plainwords li.hash,.plainwords li.partial{border-left-color:var(--amber)}
.plainwords li.encoded{border-left-color:var(--orange)}
.plainwords p{margin:0;font:18px/1.5 var(--serif);text-wrap:pretty}
.plainwords small{display:block;margin-top:6px;color:var(--muted);font-size:14px}
.plainwords a{color:inherit}
.steps{list-style:none;margin:0;padding:0;counter-reset:s}
.steps li{counter-increment:s;position:relative;padding:0 0 18px 44px;border-left:2px solid var(--rule);margin-left:13px}
.steps li:last-child{border-left-color:transparent;padding-bottom:0}
.steps li::before{content:counter(s);position:absolute;left:-14px;top:-2px;width:26px;height:26px;border-radius:50%;background:var(--card);border:2px solid var(--rule);font:600 12px/22px var(--sans);text-align:center;color:var(--muted)}
.steps li.hit::before{border-color:var(--red);color:var(--red)}
.steps li.handoff::before{content:"\\270B";border-color:var(--green);font-size:11px}
.steps li.bad::before{border-color:var(--red);background:var(--red);color:#fff}
.steps .by{font:600 11px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--green);background:var(--green-bg);padding:3px 7px;border-radius:999px;margin-left:6px}
.steps .by.stop{color:#fff;background:var(--red)}
.notice.stop{border-left-color:var(--red)}
.steps .t{color:var(--muted);font:12.5px var(--mono);margin-left:8px}
.steps .then{margin:6px 0 0;font-size:14px;color:var(--muted)}
.steps .then b{color:var(--red);font-weight:600}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:28px 0 0}
figure{margin:0;background:var(--card);border:1px solid var(--rule);border-radius:12px;overflow:hidden}
figure img{display:block;width:100%;height:auto}
figcaption{padding:10px 14px;font-size:13px;color:var(--muted);border-top:1px solid var(--rule)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.box{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:20px 22px}
.box h3{font:700 17px/1.3 var(--serif);margin:0 0 8px}
.box p,.box li{font-size:15px;color:var(--ink)}
.box ul{margin:0;padding-left:18px}
.box p{margin:0 0 8px}
.ok{color:var(--green);font-weight:600}
ol.q{margin:0;padding:0;list-style:none;counter-reset:q;display:grid;gap:14px}
ol.q li{counter-increment:q;display:grid;grid-template-columns:34px 1fr;gap:4px 8px}
ol.q li::before{content:counter(q);font:700 22px/1.25 var(--serif);color:var(--red)}
ol.q p{margin:0;font:17px/1.5 var(--serif);text-wrap:pretty}
ol.q small{grid-column:2;color:var(--muted);font-size:13px}
details{background:var(--card);border:1px solid var(--rule);border-radius:12px;margin:0 0 10px}
summary{cursor:pointer;padding:14px 18px;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:16px;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";font:400 20px/1 var(--mono);color:var(--muted)}
details[open] summary::after{content:"\\2212"}
summary span{font-weight:400;color:var(--muted);font-size:14px}
.proof{padding:4px 18px 18px;border-top:1px solid var(--rule)}
.req{padding:16px 0;border-bottom:1px dashed var(--rule)}
.req:last-child{border-bottom:0;padding-bottom:0}
.req h4{margin:0 0 8px;font:600 14px/1.4 var(--mono)}
.req h4 span{font-weight:400;color:var(--muted)}
dl{display:grid;grid-template-columns:130px 1fr;gap:6px 14px;margin:0;font-size:14px}
dt{color:var(--muted)}
dd{margin:0;min-width:0}
code,.mono{font:12.5px/1.55 var(--mono);overflow-wrap:anywhere;word-break:break-all}
code{background:var(--soft);padding:1px 5px;border-radius:4px}
.url{display:block;background:var(--soft);padding:10px 12px;border-radius:8px}
mark{background:var(--red-bg);color:var(--red);padding:1px 2px;border-radius:3px;font-weight:600}
.chain{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:4px 0}
.chain li{font:12.5px var(--mono)}
.chain li+li::before{content:"\\2192";margin:0 7px;color:var(--muted)}
.seal{font:14px/1.5 var(--mono);background:#0f0d0b;color:#f4efe6;padding:16px 18px;border-radius:12px;overflow-wrap:anywhere}
.seal span{display:block;font:600 11px var(--sans);letter-spacing:.12em;text-transform:uppercase;opacity:.6;margin-bottom:6px}
footer{padding:32px 0 56px;color:var(--muted);font-size:13.5px}
footer a{color:inherit}
@media (max-width:640px){.in{padding:0 16px}.top .in{padding:12px 16px}.hero{padding:36px 0 28px}section{padding:32px 0}
.grid th,.grid td{padding:10px 10px}.pill{font-size:12px;padding:6px 8px}dl{grid-template-columns:1fr;gap:2px}dt{margin-top:8px}.grid-wrap{overflow-x:auto}}
@media print{.top{background:none;color:inherit;border-bottom:2px solid}details{break-inside:avoid}section{break-inside:avoid-page}}
`;

function pill(cell: Cell | null): string {
  return cell ? `<span class="pill ${cell.kind}">${esc(cell.label)}</span>` : '<span class="none">Not seen</span>';
}

function excerptHtml(s: Sighting): string {
  const [a, b] = s.excerptAt;
  return `${esc(s.excerpt.slice(0, a))}<mark>${esc(s.excerpt.slice(a, b))}</mark>${esc(s.excerpt.slice(b))}`;
}

function surfaceName(s: Sighting): string {
  switch (s.surface) {
    case 'url':
      return 'Request address (URL)';
    case 'header':
      return `Request header "${s.surfaceName}"`;
    case 'body':
      return 'Request body';
    case 'websocket':
      return 'WebSocket message';
  }
}

function findingHtml(f: Finding, m: ReportModel & { requestUrl: (id: string) => string | undefined }): string {
  const tz = m.run.environment.timezone;
  const delivery =
    f.delivery === 'sandboxed'
      ? 'Recorded, then answered on this machine (sandbox). Not delivered.'
      : f.delivery === 'delivered'
        ? `Delivered. The server answered HTTP ${f.responseStatus}${f.remoteAddress ? ` from ${f.remoteAddress}` : ''}.`
        : 'The request was sent but no response was recorded.';
  const record = m.requestUrl(f.requestId);
  const rows = f.sightings
    .map(
      (s) => `
      <dt>Found in</dt><dd>${esc(surfaceName(s))}${s.field ? `, field <code>${esc(s.field)}</code>` : ''}</dd>
      <dt>Form</dt><dd>${esc(cap(s.formLabel))}${s.exactness === 'marker' ? ' (partial match)' : ''}</dd>
      ${s.chain.filter(Boolean).length ? `<dt>How to get there</dt><dd><ol class="chain"><li>${esc(surfaceName(s).toLowerCase())}</li>${s.chain.filter(Boolean).map((c) => `<li>${esc(c)}</li>`).join('')}</ol></dd>` : ''}
      <dt>What it says</dt><dd><span class="mono">${excerptHtml(s)}</span></dd>`,
    )
    .join('<dt></dt><dd></dd>');
  const ids = f.decoded?.identifiers ?? [];
  return `
  <div class="req" id="${esc(f.id)}">
    <h4>${esc(f.requestId)} <span>· ${esc(f.method)} · ${esc(clock(f.wallTime, tz))} · ${esc(f.recipient.host)}</span></h4>
    <dl>
      ${f.decoded ? `<dt>What this call is</dt><dd>${esc(f.decoded.purpose)}${f.decoded.eventName ? `. Event: <code>${esc(f.decoded.eventName)}</code>` : ''}${f.decoded.accountId ? `. Account: <code>${esc(f.decoded.accountId)}</code>` : ''}</dd>` : ''}
      ${rows}
      ${ids.length ? `<dt>Sent with it</dt><dd>${ids.map((i) => `${esc(i.meaning ?? i.name)} <code>${esc(i.name)}</code>`).join('; ')}</dd>` : ''}
      ${f.initiator?.url ? `<dt>Started by</dt><dd><code>${esc(f.initiator.url)}</code></dd>` : ''}
      <dt>Delivery</dt><dd>${esc(delivery)}</dd>
      ${record ? `<dt>Full address</dt><dd><span class="mono url">${esc(record)}</span></dd>` : ''}
    </dl>
  </div>`;
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function renderHtml(model: ReportModel & { requestUrl: (id: string) => string | undefined }): string {
  const m = model;
  const { run, analysis } = m;
  const t0 = run.startedAt;
  const leakSteps = new Map<number, LeakGroup[]>();
  for (const g of m.groups) {
    const step = g.findings[0]!.step;
    leakSteps.set(step, [...(leakSteps.get(step) ?? []), g]);
  }

  const hero = `
<div class="hero">
  <p class="eyebrow">Evidence report · ${esc(run.site.name)}</p>
  <h1>${m.groups.length ? esc(m.headline).replace(/(\d+ compan(?:y|ies))/, '<em>$1</em>') : esc(m.headline)}</h1>
  <p class="lede">${esc(m.subhead)}</p>
  <ul class="meta">
    <li><b>Journey</b> ${esc(run.journeyName)}</li>
    <li><b>When</b> ${esc(m.when)}</li>
    <li><b>Requests recorded</b> ${analysis.totals.requests}</li>
    <li><b>Outside services contacted</b> ${analysis.contacted.length}</li>
  </ul>
  ${run.capture === 'imported' ? `<p class="notice person"><b>Recorded by a person, imported from a HAR file.</b> A person did this journey in their own browser and saved the network log from its developer tools. Khara Check did not watch the recording: the seal proves nothing has changed since the file was imported, and the planted values are the ones the person says they typed.</p>` : ''}
  ${run.capture === 'attached' ? `<p class="notice person"><b>Done by a person.</b> A person did this journey by hand in their own browser. Khara Check only listened to the browser's network log: it did not click, type or run anything in the page.</p>` : ''}
  ${m.sandbox ? `<p class="notice"><b>Practice run.</b> This ran in Khara Check's sandbox against a site served from this machine. Requests to outside companies were recorded and then answered locally. Nothing reached any real company, and the names below show where the page was trying to send data.</p>` : ''}
  ${m.stopped ? `<p class="notice stop"><b>The journey did not finish.</b> It stopped after "${esc(m.stopped.after)}": ${esc(m.stopped.reason)} Findings below cover only the steps that ran, so they cannot show what the site does after that point.</p>` : ''}
  ${m.collectors.length ? `<p class="notice"><b>A data collector at the site's own address.</b> ${m.collectors.map((c) => `${esc(cap(c.labels.map((l) => `the ${l}`).join(' and ')))} went to ${esc(c.host)}, which has the shape of a ${esc(c.name)} endpoint (${c.requests} ${c.requests === 1 ? 'request' : 'requests'}: ${esc(c.requestIds.join(', '))}).`).join(' ')} A service like this runs at the site's own address but collects data for analytics or advertising, and the browser cannot see where it sends the data next.</p>` : ''}
</div>`;

  const grid = m.groups.length
    ? `
<section>
  <h2>Who received what</h2>
  <p class="sub">Each row is an outside service. Each column is something the customer typed. Khara Check typed values that exist nowhere else, then looked for them in everything the page sent out.</p>
  <div class="grid-wrap"><table class="grid">
    <thead><tr><th>Sent to</th>${analysis.canaries.map((c) => `<th>${esc(cap(c.label))}</th>`).join('')}</tr></thead>
    <tbody>
      ${m.grid.map((row) => `<tr><td class="who"><b>${esc(row.recipient)}</b>${row.vendorLine ? `<span>${esc(row.vendorLine)}</span>` : ''}</td>${row.cells.map((c) => `<td>${pill(c)}</td>`).join('')}</tr>`).join('\n      ')}
    </tbody>
  </table></div>
  <ul class="legend">
    <li><span class="pill plain">Readable</span>sent as plain text anyone can read</li>
    <li><span class="pill encoded">Encoded</span>wrapped, but readable once unwrapped</li>
    <li><span class="pill hash">Hashed</span>scrambled into a fingerprint that the receiver can match against people it already knows</li>
  </ul>
</section>

<section>
  <h2>In plain words</h2>
  <p class="sub">One line per finding. Each links to the recorded request that proves it.</p>
  <ul class="plainwords">
    ${m.groups.map((g) => `<li class="${g.cell.kind}"><p>${esc(g.sentence)}</p><small>${esc(g.detail)} <a href="#${g.id}">See the proof</a></small></li>`).join('\n    ')}
  </ul>
</section>`
    : '';

  const shots = run.steps.filter((s) => s.artifact?.endsWith('.png'));
  const timeline = `
<section>
  <h2>What the customer did</h2>
  <p class="sub">The journey, step by step, with what left the site at each point. Times are measured from the start of the run.</p>
  <ol class="steps">
    ${run.steps
      .map((s) => {
        const hits = leakSteps.get(s.index) ?? [];
        const names = [...new Set(hits.map((g) => g.recipient))];
        return `<li class="${!s.ok ? 'bad' : hits.length ? 'hit' : ''}">${esc(s.label)}${s.actor === 'person' && run.capture === 'automated' ? ' <span class="by">done by a person</span>' : ''}<span class="t">+${((s.startedAt - t0) / 1000).toFixed(1)}s</span>${
          hits.length ? `<p class="then">Then data went out to <b>${esc(names.join(', '))}</b></p>` : ''
        }${!s.ok ? `<p class="then">${esc(s.error ?? 'This step failed.')}</p>` : ''}</li>${(run.handoffs ?? [])
          .filter((h) => h.index === s.index)
          .map((h) => `<li class="${h.ok ? 'handoff' : 'bad'}">${esc(h.label)} <span class="by${h.ok ? '' : ' stop'}">${h.ok ? 'done by a person' : 'stopped'}</span><span class="t">+${((h.startedAt - t0) / 1000).toFixed(1)}s</span>${h.error ? `<p class="then">${esc(h.error)}</p>` : ''}</li>`)
          .join('')}`;
      })
      .join('\n    ')}
  </ol>
  ${shots.length ? `<div class="shots">${shots.map((s) => `<figure><img src="${esc(s.artifact)}" alt="Screenshot: ${esc(s.label)}" loading="lazy"><figcaption>Step ${s.index + 1}. ${esc(s.pageUrl)}</figcaption></figure>`).join('')}</div>` : ''}
</section>`;

  const sst = m.sst.length
    ? `
<section>
  <h2>Server-side tagging</h2>
  <p class="sub">Some sites send their Google Analytics data to a server of their own first, which then passes it on. The browser sees only the first step, so the companies at the end of the chain are hidden from this report. Detected with the method of Moti et al., "The Bitter Pill" (section 3.4): the Google tag's parameters stay the same when the address changes.</p>
  <ul>${m.sst.map((e) => `<li><b>${esc(e.host)}</b> ${esc(e.paths.join(', '))} · ${e.requests} ${e.requests === 1 ? 'request' : 'requests'} (${esc(e.requestIds.slice(0, 8).join(', '))}${e.requestIds.length > 8 ? ', …' : ''}) · ${e.confidence === 'confirmed' ? 'confirmed' : 'likely'}<br>${esc(e.sentence)}${e.addresses.length ? ` <span class="none">Server address: ${esc(e.addresses.join(', '))}.</span>` : ''}</li>`).join('')}</ul>
</section>`
    : '';

  const rest = `${sst}
<section>
  <h2>What stayed put</h2>
  <div class="cols">
    <div class="box">
      <h3>Sent to the site itself</h3>
      ${
        m.firstParty.length
          ? `<p>This is expected: a site has to receive what you type in order to work.</p><ul>${m.firstParty.map((f) => `<li>${esc(cap(f.canary.label))}: ${esc(f.ways.join(', '))} (${f.requests} ${f.requests === 1 ? 'request' : 'requests'})</li>`).join('')}</ul>`
          : '<p>None of the planted values were seen in requests to the site itself.</p>'
      }
    </div>
    <div class="box">
      <h3>Contacted, but sent nothing planted</h3>
      ${
        m.quiet.length
          ? `<p>These outside services were loaded or contacted during the run. None of the planted values were found in what they were sent.</p><ul>${m.quiet.map((q) => `<li>${esc(q.name)} <span class="none">· ${esc(q.category)} · ${q.requests} ${q.requests === 1 ? 'request' : 'requests'}</span></li>`).join('')}</ul>`
          : `<p>${analysis.contacted.length ? 'Every outside service that was contacted received at least one planted value.' : '<span class="ok">No outside service was contacted.</span>'}</p>`
      }
    </div>
  </div>
</section>`;

  const questions = m.questions.length
    ? `
<section>
  <h2>Questions this raises</h2>
  <p class="sub">Under India's Digital Personal Data Protection Act, 2023. These are questions for the site to answer, not conclusions. A capture shows what was sent. It cannot show what the customer was told or what contracts exist.</p>
  <ol class="q">
    ${m.questions.map((q) => `<li><p>${esc(q.question)}</p><small>${esc(q.basis)}</small></li>`).join('\n    ')}
  </ol>
</section>`
    : '';

  const limits = `
<section>
  <h2>What this report can and cannot say</h2>
  <div class="cols">
    <div class="box"><h3>It can say</h3><ul>
      <li>These exact requests were made by this page, in this run, at these times.</li>
      <li>The planted values were inside them, in the fields shown.</li>
      <li>Anyone holding the evidence folder can re-run the analysis and get the same result.</li>
    </ul></div>
    <div class="box"><h3>It cannot say</h3><ul>
      <li>That the site always does this, or does it for every visitor. This is one run.</li>
      <li>What the receiving company did with the data afterwards.</li>
      <li>Whether data was also shared out of sight, from the site's servers.</li>
      <li>That nothing else leaked. Values scrambled with a secret key, or encrypted inside the page, cannot be recognised.</li>
    </ul></div>
  </div>
</section>`;

  const proof = m.groups.length
    ? `
<section>
  <h2>The proof</h2>
  <p class="sub">Every finding, down to the recorded request. Request numbers match the lines of <code>capture/requests.jsonl</code> in the evidence folder.</p>
  ${m.groups
    .map(
      (g) => `<details id="${g.id}"><summary>${esc(g.recipient)} · ${esc(g.canary.label)}<span>${esc(g.cell.label)} · ${g.findings.length} ${g.findings.length === 1 ? 'request' : 'requests'}</span></summary>
  <div class="proof">${g.findings.map((f) => findingHtml(f, m)).join('')}</div></details>`,
    )
    .join('\n  ')}
</section>`
    : '';

  const env = run.environment;
  const evidence = `
<section>
  <h2>The evidence</h2>
  <p class="sub">This report sits inside an evidence folder. Every file in it is fingerprinted, and the fingerprints are chained into one value, the seal. Change one byte of evidence and the seal changes.</p>
  <div class="seal"><span>Evidence seal (SHA-256 chain)</span>${esc(m.seal)}</div>
  <div class="cols" style="margin-top:20px">
    <div class="box"><h3>Check it yourself</h3>
      <p>With the evidence folder and Khara Check installed:</p>
      <p><code>khara-check verify &lt;folder&gt;</code></p>
      <p>It recomputes every fingerprint, then repeats the whole analysis from the raw capture and confirms it matches this report, with no browser and no internet.</p>
    </div>
    <div class="box"><h3>Planted values</h3>
      <ul>${analysis.canaries.map((c) => `<li>${esc(cap(c.label))}: <code>${esc(c.value)}</code>${c.unique ? '' : ' <span class="none">(not unique to this run)</span>'}</li>`).join('')}</ul>
    </div>
    <div class="box"><h3>How it was captured</h3>
      <ul>
        <li>${esc(TOOLNAME(run))}</li>
        <li>${esc(env.browser)} ${esc(env.browserVersion)}${env.headless ? ', headless' : ', visible window'}</li>
        <li>${env.viewport.width} x ${env.viewport.height}, ${esc(env.locale)}, ${esc(env.timezone)}</li>
        <li>${esc(run.site.origin)}</li>
        <li>Run took ${esc(m.duration)}</li>
      </ul>
    </div>
  </div>
  ${run.notes.length ? `<p class="sub" style="margin:20px 0 0">${run.notes.map(esc).join(' ')}</p>` : ''}
</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(run.site.name)}: who was told what you typed | Khara Check</title>
<meta name="description" content="${esc(m.headline)}">
<style>${CSS}</style>
</head>
<body>
<div class="top"><div class="in"><span class="mark">Khara <b>Check</b></span><small>seal ${esc(m.seal.slice(0, 16))}…</small></div></div>
<div class="in">
${hero}
${grid}
${timeline}
${rest}
${questions}
${limits}
${proof}
${evidence}
<footer>Made with <a href="https://github.com/ryansethi13555-art/khara-check">Khara Check</a> ${esc(run.tool.version)}, an open source tool that proves what websites tell other companies about you. Findings describe this run only.</footer>
</div>
</body>
</html>
`;
}

function TOOLNAME(run: ReportModel['run']): string {
  return `${run.tool.name} ${run.tool.version}, Playwright ${run.environment.playwright}`;
}
