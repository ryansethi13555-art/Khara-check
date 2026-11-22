#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { compare, summarizeRun } from './compare/compare.js';
import { renderComparisonHtml, renderComparisonMarkdown } from './compare/render.js';
import path from 'node:path';
import { writeEvidence } from './evidence/bundle.js';
import { verifyBundle, writeDerived } from './evidence/derive.js';
import { loadJourney, type Journey } from './journey/schema.js';
import { bold, dim, red, summaryText, verificationText } from './report/terminal.js';
import { TOOL } from './version.js';
import type { RunResult } from './journey/runner.js';

const HELP = `
${bold('khara-check')} ${TOOL.version}  proves what a website tells other companies about you

  ${bold('khara-check run')} <journey.yaml>     play a customer journey, record everything, write an evidence folder
      --out <folder>             where to write it (default: runs/<time>-<name>)
      --headed                   show the browser window
      --seed <text>              make the planted values repeatable (for demos and tests)
      --consent all|reject|accept   answer the cookie banner (journey needs "consent:"); "all" runs
                                 three times (ignored, Reject all, Accept all) and compares them
      --repeat <n>               run n times and count how often each leak appears
      If the site shows a bot check, CAPTCHA, OTP or login, Khara Check never solves it. In a --headed
      run it pauses so you can clear it by hand, then carries on; the handoff goes in the evidence.

  ${bold('khara-check attach')} <journey.yaml>  listen while YOU do the journey in your own Chrome (for sites that block automation)
      --cdp <address>            your Chrome's DevTools address (default http://127.0.0.1:9222)
      --out <folder>             where to write the evidence
      Start Chrome first, with a separate clean profile:
        google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/khara-check-profile"

  ${bold('khara-check import')} <file.har>      check traffic a person recorded in DevTools ("Save all as HAR")
      --site <address>           the site that was tested, e.g. https://pharmacy.example.in
      --search <text>            exactly what was typed in the search box (repeat for several)
      --email <text>             the email address that was typed
      --phone-env <NAME>         read the phone number that was typed from this environment variable
      --unique                   the values carry a marker that exists nowhere else (stronger evidence)
      --out <folder>             where to write the evidence

  ${bold('khara-check fleet')} <list.yaml>      run many journeys and write one scorecard (compare.html)
  ${bold('khara-check compare')} <folders…>    build a comparison or scorecard from evidence folders you already have

  ${bold('khara-check verify')} <folder>        check an evidence folder: fingerprints, seal, and the findings themselves
      --seal <hash>              also check against a seal that was published earlier

  ${bold('khara-check report')} <folder>        rebuild findings and reports from the evidence (no browser needed)

Try it now, entirely on this machine:
  khara-check run journeys/examples/fixture-pharmacy.yaml
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
  /** Every value of a flag given more than once, in order (e.g. several --search). */
  multi: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const multi: Record<string, string[]> = {};
  const takesValue = new Set(['site', 'search', 'email', 'phone-env', 'out', 'seed', 'seal', 'port', 'journey', 'name', 'cdp', 'consent', 'repeat', 'title']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      let value: string | true = true;
      if (inline !== undefined) value = inline;
      else if (takesValue.has(name)) {
        const next = rest[++i];
        if (next === undefined) throw new Error(`--${name} needs a value`);
        value = next;
      }
      flags[name] = value;
      if (typeof value === 'string') (multi[name] ??= []).push(value);
    } else positional.push(arg);
  }
  return { command, positional, flags, multi };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
}

function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function run(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) throw new Error('Which journey? Example: khara-check run journeys/examples/fixture-pharmacy.yaml');
  const journey = loadJourney(file);
  const outDir = path.resolve(typeof args.flags.out === 'string' ? args.flags.out : path.join('runs', `${stamp()}-${slug(journey.name)}`));
  const conditions = consentConditions(args.flags.consent, journey.consent !== undefined);
  const repeat = Math.max(1, Math.min(20, Number(args.flags.repeat ?? 1) || 1));
  const seed = typeof args.flags.seed === 'string' ? args.flags.seed : undefined;

  if (conditions.length === 1 && repeat === 1) {
    return runOne(journey, outDir, { headed: Boolean(args.flags.headed), ...(seed ? { seed } : {}), consent: conditions[0]! });
  }

  // Several runs: one sealed folder each, then a comparison across them.
  const dirs: string[] = [];
  let worst = 0;
  for (let i = 1; i <= repeat; i++) {
    for (const condition of conditions) {
      const name = `${condition}${repeat > 1 ? `-${i}` : ''}`;
      console.log(bold(`\n── ${name} ──`));
      const code = await runOne(journey, path.join(outDir, name), {
        headed: Boolean(args.flags.headed),
        ...(seed ? { seed: `${seed}:${name}` } : {}),
        consent: condition,
        quiet: true,
      });
      worst = Math.max(worst, code);
      dirs.push(path.join(outDir, name));
    }
  }
  writeComparison(dirs, outDir);
  return worst;
}

type ConsentChoice = 'no-choice' | 'reject' | 'accept';

function consentConditions(flag: string | true | undefined, hasBanner: boolean): ConsentChoice[] {
  if (flag === undefined) return ['no-choice'];
  if (!hasBanner) throw new Error('--consent needs the journey to describe the consent banner: add consent: { accept: "<selector>", reject: "<selector>" }');
  const value = flag === true ? 'all' : flag;
  if (value === 'all') return ['no-choice', 'reject', 'accept'];
  const map: Record<string, ConsentChoice> = { none: 'no-choice', ignore: 'no-choice', reject: 'reject', accept: 'accept' };
  const choice = map[value];
  if (!choice) throw new Error('--consent takes all, none, reject or accept');
  return [choice];
}

async function runOne(
  journey: Journey,
  outDir: string,
  opts: { headed: boolean; seed?: string; consent: ConsentChoice; quiet?: boolean },
): Promise<number> {
  if (existsSync(path.join(outDir, 'manifest.json'))) {
    throw new Error(`${outDir} already holds an evidence bundle. Evidence is never overwritten: choose another --out folder.`);
  }
  mkdirSync(outDir, { recursive: true });

  if (!opts.quiet) {
    console.log(`\n${bold(journey.name)}`);
    console.log(dim(`${journey.site.name} · ${journey.network.mode === 'sandbox' ? 'sandbox (nothing leaves this machine)' : 'live'}`));
    console.log('');
  }

  // Imported here so that `verify` and `report` never load a browser.
  const { runJourney } = await import('./journey/runner.js');
  const handoff = opts.headed ? await askPerson() : undefined;
  const result = await runJourney(journey, {
    outDir,
    headless: !opts.headed,
    consent: opts.consent,
    ...(handoff ? { handoff } : {}),
    ...(opts.seed ? { seed: opts.seed } : {}),
    log: (message) => console.log(dim(message)),
  });
  return finishRun(outDir, journey.sourceText, result);
}

function writeComparison(dirs: string[], outDir: string, title?: string): void {
  const summaries = dirs.map((d) => summarizeRun(d));
  const cmp = compare(summaries, title);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'compare.html'), renderComparisonHtml(cmp, outDir));
  writeFileSync(path.join(outDir, 'compare.md'), renderComparisonMarkdown(cmp, outDir));
  console.log(`\n${bold(cmp.title)}`);
  for (const site of cmp.sites) {
    if (cmp.sites.length > 1) console.log(`\n  ${bold(site.site)}`);
    for (const line of site.lines) console.log(`  ${line}`);
  }
  console.log(`\n  Comparison  ${path.relative(process.cwd(), path.join(outDir, 'compare.html'))}\n`);
}

/** Many journeys, one scorecard. */
async function fleet(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) throw new Error('Which list? Example: khara-check fleet journeys/fleet-example.yaml');
  const spec = parseYaml(readFileSync(file, 'utf8')) as { name?: string; journeys?: string[]; consent?: string; repeat?: number };
  if (!Array.isArray(spec?.journeys) || !spec.journeys.length) throw new Error(`${file} needs a "journeys" list`);
  const outDir = path.resolve(typeof args.flags.out === 'string' ? args.flags.out : path.join('runs', `${stamp()}-fleet`));
  const dirs: string[] = [];
  let worst = 0;
  for (const rel of spec.journeys) {
    const journey = loadJourney(path.resolve(path.dirname(file), rel));
    const conditions = journey.consent ? consentConditions(spec.consent ?? 'all', true) : (['no-choice'] as ConsentChoice[]);
    for (let i = 1; i <= Math.max(1, Number(spec.repeat ?? 1)); i++) {
      for (const condition of conditions) {
        const name = `${slug(journey.site.name)}-${condition}${spec.repeat && spec.repeat > 1 ? `-${i}` : ''}`;
        console.log(bold(`\n── ${journey.site.name} · ${condition} ──`));
        const seed = typeof args.flags.seed === 'string' ? `${args.flags.seed}:${name}` : undefined;
        worst = Math.max(worst, await runOne(journey, path.join(outDir, name), { headed: Boolean(args.flags.headed), consent: condition, quiet: true, ...(seed ? { seed } : {}) }));
        dirs.push(path.join(outDir, name));
      }
    }
  }
  writeComparison(dirs, outDir, spec.name);
  return worst;
}

function compareCommand(args: Args): number {
  if (!args.positional.length) throw new Error('Which folders? Example: khara-check compare runs/a runs/b --out runs/compare');
  const outDir = path.resolve(typeof args.flags.out === 'string' ? args.flags.out : path.join('runs', `${stamp()}-compare`));
  writeComparison(args.positional.map((d) => path.resolve(d)), outDir, typeof args.flags.title === 'string' ? args.flags.title : undefined);
  return 0;
}

function finishRun(outDir: string, journeyText: string, result: RunResult): number {
  writeEvidence(outDir, {
    journeyText,
    run: result.run,
    canaries: result.canaries,
    records: result.records,
    cookies: result.cookies,
  });
  const derived = writeDerived(outDir);

  console.log(summaryText(derived.model));
  console.log('');
  console.log(`  Report    ${path.relative(process.cwd(), path.join(outDir, 'report.html'))}`);
  console.log(`  Evidence  ${path.relative(process.cwd(), outDir)}  ${dim(`(${derived.manifest.evidence.length} files, ${result.records.length} requests)`)}`);
  console.log(`  Seal      ${derived.seal}`);
  console.log('');
  if (result.failure) {
    console.log(red(`  ${result.failure}`));
    return 2;
  }
  return 0;
}

/** In a watched run, a person can take over the browser: Khara Check waits for Enter. */
async function askPerson(): Promise<(message: string) => Promise<void>> {
  const { createInterface } = await import('node:readline');
  return (message) =>
    new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      console.log(`\n  ${bold('Your turn.')} ${message}`);
      rl.question(dim('  Khara Check is paused and still recording. Press Enter here when you are done. '), () => {
        rl.close();
        resolve();
      });
    });
}

async function attach(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) throw new Error('Which journey? Example: khara-check attach journeys/examples/fixture-pharmacy.yaml');
  const journey = loadJourney(file);
  const outDir = path.resolve(typeof args.flags.out === 'string' ? args.flags.out : path.join('runs', `${stamp()}-${slug(journey.name)}-by-hand`));
  if (existsSync(path.join(outDir, 'manifest.json'))) {
    throw new Error(`${outDir} already holds an evidence bundle. Evidence is never overwritten: choose another --out folder.`);
  }
  const endpoint = typeof args.flags.cdp === 'string' ? args.flags.cdp : 'http://127.0.0.1:9222';
  const { attachJourney } = await import('./attach/attach.js');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, terminal: false });
  process.once('SIGINT', () => rl.close());

  console.log(`\n${bold(journey.name)}`);
  console.log(dim(`${journey.site.name} · by hand · ${journey.network.mode === 'sandbox' ? 'sandbox' : 'live'} · listening at ${endpoint}`));
  console.log('');
  const result = await attachJourney(journey, {
    endpoint,
    outDir,
    ...(typeof args.flags.seed === 'string' ? { seed: args.flags.seed } : {}),
    io: { show: (text) => console.log(text + '\n'), marks: rl },
  });
  rl.close();
  return finishRun(outDir, journey.sourceText, result);
}

/** A HAR file recorded by a person, checked with the same matcher and sealed the same way. */
async function importCommand(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) throw new Error('Which HAR file? Example: khara-check import pharmacy.har --site https://pharmacy.example.in --search "metformin 500"');
  const site = typeof args.flags.site === 'string' ? args.flags.site : undefined;
  if (!site) throw new Error('Which site was tested? Add --site https://… (its own requests are not counted as leaks)');
  const values = args.multi.search ?? [];
  const email = typeof args.flags.email === 'string' ? args.flags.email : undefined;
  const phoneEnv = typeof args.flags['phone-env'] === 'string' ? args.flags['phone-env'] : undefined;
  if (!values.length && !email && !phoneEnv) {
    throw new Error('Tell Khara Check what was typed: --search "<text>", --email <address> or --phone-env <VARIABLE>');
  }
  const unique = args.flags.unique === true;
  const { stringify } = await import('yaml');
  const { parseJourney } = await import('./journey/schema.js');
  const { importHar, parseHar } = await import('./har/import.js');
  const host = new URL(site).hostname.replace(/^www\./, '');
  const name = typeof args.flags.name === 'string' ? args.flags.name : host;
  const canaries: Record<string, unknown> = {};
  values.forEach((v, i) => (canaries[values.length > 1 ? `search${i + 1}` : 'search'] = { type: 'search-term', value: v, unique, label: values.length > 1 ? `search for "${v}"` : 'search' }));
  if (email) canaries.email = { type: 'email', value: email, unique };
  // The phone number itself never goes into the journey file, only the variable's name.
  if (phoneEnv) canaries.phone = { type: 'phone', valueFromEnv: phoneEnv, unique };
  const journeyText =
    `# Written by khara-check import: describes a journey a person recorded by hand and saved as ${path.basename(file)}.\n` +
    stringify({ name: `${name}, recorded by hand`, site: { name, url: site }, network: { mode: 'live' }, canaries, steps: [{ goto: '/' }] });
  const journey = parseJourney(journeyText, path.resolve(`${slug(name)}-import.yaml`));

  const outDir = path.resolve(typeof args.flags.out === 'string' ? args.flags.out : path.join('runs', `${stamp()}-${slug(name)}-imported`));
  if (existsSync(path.join(outDir, 'manifest.json'))) {
    throw new Error(`${outDir} already holds an evidence bundle. Evidence is never overwritten: choose another --out folder.`);
  }
  const raw = readFileSync(file);
  const har = parseHar(raw.toString('utf8'), path.basename(file));
  const { ownHosts, resolveAliases } = await import('./capture/dns.js');
  const { hostMatches, registrableDomain } = await import('./util/domains.js');
  const own = registrableDomain(new URL(site).hostname);
  const dns = args.flags['no-dns'] === true ? {} : await resolveAliases(ownHosts(har.log.entries.map((e) => e.request.url), (h) => hostMatches(h, own)));
  const result = importHar(har, journey, { fileName: path.basename(file), dns });
  mkdirSync(path.join(outDir, 'capture'), { recursive: true });
  writeFileSync(path.join(outDir, 'capture/original.har'), raw);
  console.log(`\n${bold(journey.name)}`);
  console.log(dim(`${name} · imported from ${path.basename(file)} · ${result.records.length} requests`));
  return finishRun(outDir, journeyText, result as RunResult);
}

function verify(args: Args): number {
  const dir = args.positional[0];
  if (!dir) throw new Error('Which folder? Example: khara-check verify runs/20261111-120000-my-run');
  const result = verifyBundle(path.resolve(dir), typeof args.flags.seal === 'string' ? { expectedSeal: args.flags.seal } : {});
  console.log(`\n${bold('Verifying')} ${dir}\n`);
  console.log(verificationText(result));
  console.log('');
  return result.ok ? 0 : 1;
}

function report(args: Args): number {
  const dir = args.positional[0];
  if (!dir) throw new Error('Which folder? Example: khara-check report runs/20261111-120000-my-run');
  const abs = path.resolve(dir);
  // Rebuilding reports also re-seals the folder, so it is only allowed on intact evidence.
  if (existsSync(path.join(abs, 'manifest.json'))) {
    const check = verifyBundle(abs);
    const broken = check.checks.filter((c) => !c.ok && (c.name === 'Evidence files' || c.name === 'Evidence seal' || c.name === 'Request log chain'));
    if (broken.length) {
      throw new Error(`the evidence in ${dir} no longer matches its seal (${broken.map((c) => c.detail).join('; ')}). Refusing to re-seal it.`);
    }
  }
  const derived = writeDerived(abs);
  console.log(summaryText(derived.model));
  console.log(`\n  Report  ${path.join(dir, "report.html")}\n  Seal    ${derived.seal}\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'run':
      return run(args);
    case 'attach':
      return attach(args);
    case 'import':
      return importCommand(args);
    case 'fleet':
      return fleet(args);
    case 'compare':
      return compareCommand(args);
    case 'verify':
      return verify(args);
    case 'report':
      return report(args);
    case 'version':
    case '--version':
    case '-v':
      console.log(TOOL.version);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.log(HELP);
      throw new Error(`Unknown command "${args.command}"`);
  }
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`\n${red('khara-check:')} ${err.message}\n`);
    process.exit(1);
  },
);
