import type { Sighting } from '../types.js';
import type { CanaryForm } from './forms.js';
import { chainOf, unfold, type LayerNode } from './unfold.js';

/** One raw piece of a request that can carry data out: the URL, a header, the body, a socket frame. */
export interface Surface {
  surface: Sighting['surface'];
  surfaceName?: string;
  text: string;
  /** Decoding already applied before the text was handed over (e.g. "gunzipped"). */
  preSteps?: string[];
}

interface NodeHit {
  node: LayerNode;
  form: CanaryForm;
  offset: number;
}

const RANK: Record<string, number> = { 'plain:full': 0, 'encoded:full': 1, 'hash:full': 2, 'plain:marker': 3 };
const rank = (f: CanaryForm): number => RANK[`${f.kind}:${f.exactness}`] ?? 9;

function find(text: string, lower: string, form: CanaryForm): number {
  return form.caseSensitive ? text.indexOf(form.needle) : lower.indexOf(form.needle);
}

/**
 * Looks for every form of every canary in every decoded layer of one surface.
 * Returns one sighting per (canary, field): the deepest layer that still contains the
 * value, so the report can name the exact parameter and the exact wrapping.
 */
export function scanSurface(input: Surface, forms: CanaryForm[]): Sighting[] {
  if (!input.text) return [];
  const nodes = unfold(input.text);
  const rootLower = input.text.toLowerCase();

  // Best form per canary for each layer.
  const hits = new Map<number, Map<string, NodeHit>>();
  for (const node of nodes) {
    const lower = node.text.toLowerCase();
    for (const form of forms) {
      const offset = find(node.text, lower, form);
      if (offset === -1) continue;
      let perCanary = hits.get(node.id);
      if (!perCanary) hits.set(node.id, (perCanary = new Map()));
      const existing = perCanary.get(form.canary);
      if (!existing || rank(form) < rank(existing.form)) perCanary.set(form.canary, { node, form, offset });
    }
  }
  if (!hits.size) return [];

  // Keep only the deepest layers: a hit is dropped when a layer below it also holds the canary.
  const hasDeeperHit = new Set<string>();
  for (const [nodeId, perCanary] of hits) {
    for (const canary of perCanary.keys()) {
      for (let p = nodes[nodeId]!.parent; p !== -1; p = nodes[p]!.parent) hasDeeperHit.add(`${p}:${canary}`);
    }
  }

  const sightings: Sighting[] = [];
  for (const [nodeId, perCanary] of [...hits].sort((a, b) => a[0] - b[0])) {
    for (const [canary, hit] of perCanary) {
      if (hasDeeperHit.has(`${nodeId}:${canary}`)) continue;
      const chain = chainOf(nodes, hit.node);
      const wrapped = chain.find((n) => n.obfuscation)?.obfuscation;
      const formKind: Sighting['formKind'] =
        hit.form.kind === 'plain' && wrapped ? 'encoded' : hit.form.kind;
      const formLabel =
        hit.form.kind === 'plain' && wrapped ? `${wrappedLabel(wrapped)} (readable once decoded)` : hit.form.label;
      const rawOffset = find(input.text, rootLower, hit.form);
      const fieldParts = chain.map((n) => n.field).filter((f): f is string => f !== undefined);
      sightings.push({
        canary,
        formId: hit.form.id,
        formKind,
        formLabel,
        exactness: hit.form.exactness,
        surface: input.surface,
        ...(input.surfaceName ? { surfaceName: input.surfaceName } : {}),
        chain: [...(input.preSteps ?? []), ...chain.map((n) => n.step)],
        field: fieldParts.join(' › '),
        offset: hit.offset,
        length: hit.form.needle.length,
        ...(rawOffset !== -1 ? { rawOffset } : {}),
        ...excerpt(hit.node.text, hit.offset, hit.form.needle.length),
      });
    }
  }
  return sightings;
}

function wrappedLabel(kind: NonNullable<LayerNode['obfuscation']>): string {
  switch (kind) {
    case 'base64':
      return 'base64-encoded';
    case 'lz-string':
      return 'compressed (LZ-string)';
    case 'gzip':
      return 'compressed (gzip)';
    case 'jwt':
      return 'inside a signed token (JWT)';
    case 'protobuf':
      return 'packed as binary (protobuf)';
  }
}

function excerpt(text: string, offset: number, length: number, pad = 28): Pick<Sighting, 'excerpt' | 'excerptAt'> {
  const start = Math.max(0, offset - pad);
  const end = Math.min(text.length, offset + length + pad);
  const clean = (s: string): string => s.replace(/\s/g, ' ');
  const lead = (start > 0 ? '…' : '') + clean(text.slice(start, offset));
  const match = clean(text.slice(offset, offset + length));
  const tail = clean(text.slice(offset + length, end)) + (end < text.length ? '…' : '');
  return { excerpt: lead + match + tail, excerptAt: [lead.length, lead.length + match.length] };
}
