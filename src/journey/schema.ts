import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { CanarySpec } from '../canary/generate.js';
import type { CanaryType } from '../types.js';

export type Step = { label?: string } & (
  | { action: 'goto'; url: string }
  | { action: 'type'; selector: string; text: string; delayMs: number }
  | { action: 'fill'; selector: string; text: string }
  | { action: 'press'; key: string; selector?: string }
  | { action: 'click'; selector: string }
  | { action: 'check'; selector: string }
  | { action: 'select'; selector: string; value: string }
  | { action: 'waitFor'; selector: string; timeoutMs: number }
  | { action: 'wait'; ms: number }
  | { action: 'screenshot'; name: string }
  | { action: 'snapshot'; name: string }
  | { action: 'handoff'; say: string; until?: string; timeoutMs: number }
);

export interface Journey {
  name: string;
  description?: string;
  site: {
    name: string;
    /** Address of a live site. Exactly one of `url` and `serve` is set. */
    url?: string;
    /** Folder that Khara Check serves on this machine and treats as the site. */
    serve?: string;
    port: number;
    /** Extra domains owned by the site itself (its CDN, its API), so they are not counted as third parties. */
    firstParty: string[];
  };
  network: {
    /** "sandbox": nothing leaves this machine. "live": the real internet. */
    mode: 'sandbox' | 'live';
    /** Folder of canned third-party responses, laid out as <host>/<path>. Sandbox only. */
    stubs?: string;
  };
  browser: {
    viewport: { width: number; height: number };
    locale: string;
    timezone: string;
    userAgent?: string;
  };
  /** The site's consent banner, so a run can answer it ("reject" or "accept") or leave it alone. */
  consent?: { accept: string; reject: string };
  canaries: Record<string, CanarySpec>;
  steps: Step[];
  /** Pause after every step so late beacons are caught, in milliseconds. */
  settleMs: number;
  /** Absolute path of the journey file, and its exact text (copied into the evidence bundle). */
  file: string;
  sourceText: string;
}

class JourneyError extends Error {
  constructor(file: string, message: string) {
    super(`${path.basename(file)}: ${message}`);
    this.name = 'JourneyError';
  }
}

const CANARY_TYPES: CanaryType[] = ['search-term', 'email', 'phone', 'text'];

export function loadJourney(file: string): Journey {
  const abs = path.resolve(file);
  let sourceText: string;
  try {
    sourceText = readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`Cannot read the journey file ${file}`);
  }
  return parseJourney(sourceText, abs);
}

export function parseJourney(sourceText: string, file: string): Journey {
  const fail = (message: string): never => {
    throw new JourneyError(file, message);
  };
  let raw: any;
  try {
    raw = parse(sourceText);
  } catch (err) {
    fail(`not valid YAML (${(err as Error).message})`);
  }
  if (!raw || typeof raw !== 'object') fail('the file is empty');
  const dir = path.dirname(file);

  const name = str(raw.name) ?? fail('"name" is required');
  const site = raw.site ?? fail('"site" is required');
  const url = str(site.url);
  const serve = str(site.serve);
  if (!url === !serve) fail('"site" needs exactly one of "url" (a live site) or "serve" (a local folder)');
  if (url && !/^https?:\/\//i.test(url)) fail('"site.url" must start with http:// or https://');

  const mode = str(raw.network?.mode) ?? (serve ? 'sandbox' : 'live');
  if (mode !== 'sandbox' && mode !== 'live') fail('"network.mode" must be "sandbox" or "live"');
  if (serve && mode !== 'sandbox') {
    fail('a site served from a local folder always runs in sandbox mode, so practice data never reaches real trackers');
  }
  if (url && mode !== 'live') fail('sandbox mode needs "site.serve" (a local folder); a live "site.url" runs in live mode');
  const stubs = str(raw.network?.stubs);
  if (stubs && mode !== 'sandbox') fail('"network.stubs" only makes sense with network.mode: sandbox');

  const canaries: Record<string, CanarySpec> = {};
  const rawCanaries = raw.canaries ?? fail('"canaries" is required: list at least one test value to plant');
  for (const [key, value] of Object.entries<any>(rawCanaries)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(key)) fail(`canary name "${key}" must be letters, digits and underscores`);
    const spec = typeof value === 'string' ? { type: value } : (value ?? {});
    if (!CANARY_TYPES.includes(spec.type)) {
      fail(`canary "${key}" needs a "type": one of ${CANARY_TYPES.join(', ')}`);
    }
    canaries[key] = {
      type: spec.type,
      ...(str(spec.base) !== undefined ? { base: str(spec.base) } : {}),
      ...(spec.value !== undefined ? { value: String(spec.value) } : {}),
      ...(str(spec.valueFromEnv) !== undefined ? { valueFromEnv: str(spec.valueFromEnv) } : {}),
      ...(typeof spec.unique === 'boolean' ? { unique: spec.unique } : {}),
      ...(str(spec.domain) !== undefined ? { domain: str(spec.domain) } : {}),
      ...(spec.countryCode !== undefined ? { countryCode: String(spec.countryCode) } : {}),
      ...(str(spec.label) !== undefined ? { label: str(spec.label) } : {}),
    };
  }
  if (!Object.keys(canaries).length) fail('"canaries" is empty');

  if (!Array.isArray(raw.steps) || !raw.steps.length) fail('"steps" must be a non-empty list');
  const steps: Step[] = raw.steps.map((s: any, i: number) => parseStep(s, i + 1, fail));

  // Every {{name}} used in a step must be a declared canary.
  for (const step of steps) {
    for (const text of Object.values(step)) {
      if (typeof text !== 'string') continue;
      for (const m of text.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)) {
        if (!canaries[m[1]!]) fail(`a step uses {{${m[1]}}} but there is no canary with that name`);
      }
    }
  }

  return {
    name,
    ...(str(raw.description) ? { description: str(raw.description)! } : {}),
    site: {
      name: str(site.name) ?? name,
      ...(url ? { url: url.replace(/\/+$/, '') } : {}),
      ...(serve ? { serve: path.resolve(dir, serve) } : {}),
      port: Number.isInteger(site.port) ? site.port : 0,
      firstParty: Array.isArray(site.firstParty) ? site.firstParty.map(String) : [],
    },
    network: { mode: mode as 'sandbox' | 'live', ...(stubs ? { stubs: path.resolve(dir, stubs) } : {}) },
    browser: {
      viewport: {
        width: Number(raw.browser?.viewport?.width) || 1280,
        height: Number(raw.browser?.viewport?.height) || 800,
      },
      locale: str(raw.browser?.locale) ?? 'en-IN',
      timezone: str(raw.browser?.timezone) ?? 'Asia/Kolkata',
      ...(str(raw.browser?.userAgent) ? { userAgent: str(raw.browser.userAgent)! } : {}),
    },
    ...(raw.consent
      ? {
          consent: {
            accept: str(raw.consent.accept) ?? fail('"consent.accept" needs the selector of the "Accept all" button'),
            reject: str(raw.consent.reject) ?? fail('"consent.reject" needs the selector of the "Reject all" button'),
          },
        }
      : {}),
    canaries,
    steps,
    settleMs: Number.isFinite(Number(raw.settleMs)) ? Number(raw.settleMs) : 600,
    file,
    sourceText,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function parseStep(raw: any, n: number, fail: (m: string) => never): Step {
  if (!raw || typeof raw !== 'object') fail(`step ${n} is not a mapping like "- click: '#go'"`);
  const label = str(raw.label);
  const keys = Object.keys(raw).filter((k) => k !== 'label');
  if (keys.length !== 1) fail(`step ${n} must have exactly one action (found: ${keys.join(', ') || 'none'})`);
  const action = keys[0]!;
  const v = raw[action];
  const withLabel = <T extends object>(step: T): T & { label?: string } => (label ? { ...step, label } : step);
  const need = (value: unknown, what: string): string =>
    str(value) ?? fail(`step ${n} (${action}) needs ${what}`);

  switch (action) {
    case 'goto':
      return withLabel({ action, url: need(v, 'an address, e.g. "goto: /search"') });
    case 'type':
      return withLabel({
        action,
        selector: need(v?.into, '"into": the field to type into'),
        text: need(v?.text, '"text": what to type'),
        delayMs: Number.isFinite(Number(v?.delayMs)) ? Number(v.delayMs) : 35,
      });
    case 'fill':
      return withLabel({ action, selector: need(v?.into, '"into"'), text: need(v?.text, '"text"') });
    case 'press':
      return typeof v === 'string'
        ? withLabel({ action, key: v })
        : withLabel({ action, key: need(v?.key, '"key"'), ...(str(v?.in) ? { selector: str(v.in)! } : {}) });
    case 'click':
    case 'check':
      return withLabel({ action, selector: need(v, 'a selector') });
    case 'select':
      return withLabel({ action, selector: need(v?.in, '"in"'), value: need(v?.value, '"value"') });
    case 'waitFor':
      return typeof v === 'string'
        ? withLabel({ action, selector: v, timeoutMs: 15000 })
        : withLabel({ action, selector: need(v?.selector, '"selector"'), timeoutMs: Number(v?.timeoutMs) || 15000 });
    case 'wait':
      if (!Number.isFinite(Number(v))) fail(`step ${n} (wait) needs a number of milliseconds`);
      return withLabel({ action, ms: Number(v) });
    case 'screenshot':
    case 'snapshot':
      return withLabel({ action, name: need(v, 'a short name').replace(/[^a-z0-9-]+/gi, '-') });
    case 'handoff':
      return typeof v === 'string'
        ? withLabel({ action, say: v, timeoutMs: 15 * 60_000 })
        : withLabel({
            action,
            say: need(v?.say, '"say": what the person should do'),
            ...(str(v?.until) ? { until: str(v.until)! } : {}),
            timeoutMs: Number(v?.timeoutMs) || 15 * 60_000,
          });
    default:
      return fail(
        `step ${n}: unknown action "${action}". Known actions: goto, type, fill, press, click, check, select, waitFor, wait, screenshot, snapshot, handoff`,
      );
  }
}

/** Replaces {{name}} with the canary's value. */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, name: string) => values[name] ?? `{{${name}}}`);
}

/** A sentence describing a step, for the report. Never reveals more than the journey file does. */
export function describeStep(step: Step, canaryLabels: Record<string, string>): string {
  if (step.label) return step.label;
  const what = (text: string): string => {
    const names = [...text.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => canaryLabels[m[1]!] ?? m[1]!);
    return names.length ? `the ${names.join(' and ')}` : `"${text}"`;
  };
  switch (step.action) {
    case 'goto':
      return `Opened ${step.url}`;
    case 'type':
      return `Typed ${what(step.text)}`;
    case 'fill':
      return `Entered ${what(step.text)}`;
    case 'press':
      return `Pressed ${step.key}`;
    case 'click':
      return `Clicked ${step.selector}`;
    case 'check':
      return `Ticked ${step.selector}`;
    case 'select':
      return `Chose "${step.value}"`;
    case 'waitFor':
      return `Waited for ${step.selector} to appear`;
    case 'wait':
      return `Waited ${step.ms} ms`;
    case 'screenshot':
      return `Took a screenshot (${step.name})`;
    case 'snapshot':
      return `Saved the page HTML (${step.name})`;
    case 'handoff':
      return `Handed over to a person: ${step.say}`;
  }
}
