import type { Canary } from '../types.js';
import { digest, type HashAlgorithm } from '../util/hash.js';

/**
 * One disguise a canary can travel in. The matcher looks for `needle` inside every
 * decoded layer of every request.
 */
export interface CanaryForm {
  canary: string;
  /** Stable id, e.g. "plain", "plain:hyphen", "sha256:lowercase", "base64:align1". */
  id: string;
  kind: 'plain' | 'encoded' | 'hash';
  needle: string;
  /** Hash hex and plain text are compared without regard to case; base64 is not. */
  caseSensitive: boolean;
  exactness: 'full' | 'marker';
  /** Plain-language description, used in reports. */
  label: string;
}

const HASHES: { algorithm: HashAlgorithm; name: string }[] = [
  { algorithm: 'sha256', name: 'SHA-256' },
  { algorithm: 'sha1', name: 'SHA-1' },
  { algorithm: 'md5', name: 'MD5' },
];

/** Shortest plain needle we are willing to search for. Shorter strings collide with ordinary text. */
export const MIN_PLAIN_NEEDLE = 6;

interface Variant {
  id: string;
  text: string;
  describe: string;
}

/** The normalised versions of a value that trackers are known to hash or send. */
export function normalisedVariants(canary: Canary): Variant[] {
  const v = canary.value;
  const out: Variant[] = [{ id: 'as-typed', text: v, describe: 'exactly as typed' }];
  const push = (id: string, text: string, describe: string): void => {
    if (text && !out.some((o) => o.text === text)) out.push({ id, text, describe });
  };

  switch (canary.type) {
    case 'email': {
      const lower = v.trim().toLowerCase();
      push('lowercase', lower, 'lower-cased and trimmed');
      const [local, domain] = lower.split('@');
      if (local && (domain === 'gmail.com' || domain === 'googlemail.com')) {
        // Google's enhanced conversions removes dots and "+tags" from Gmail addresses before hashing.
        push('gmail-normalised', `${local.split('+')[0]!.replace(/\./g, '')}@${domain}`, 'Gmail-normalised');
      }
      break;
    }
    case 'phone': {
      const cc = canary.countryCode ?? '91';
      const digits = v.replace(/\D/g, '');
      // National number: strip a leading country code or trunk zero if the person typed one.
      let national = digits;
      if (national.length > 10 && national.startsWith(cc)) national = national.slice(cc.length);
      if (national.length > 10 && national.startsWith('0')) national = national.replace(/^0+/, '');
      push('national', national, 'digits only, no country code');
      push('cc', `${cc}${national}`, `digits only with country code ${cc}`);
      push('e164', `+${cc}${national}`, `international format (+${cc})`);
      push('trunk0', `0${national}`, 'with a leading 0');
      push('00cc', `00${cc}${national}`, `with 00${cc} prefix`);
      break;
    }
    default: {
      const trimmed = v.trim();
      push('trimmed', trimmed, 'trimmed');
      push('lowercase', trimmed.toLowerCase(), 'lower-cased and trimmed');
      push('collapsed', trimmed.toLowerCase().replace(/\s+/g, ' '), 'lower-cased, spaces collapsed');
      push('nospace', trimmed.toLowerCase().replace(/\s+/g, ''), 'lower-cased, spaces removed');
      break;
    }
  }
  return out;
}

/**
 * The parts of base64(value) that stay the same no matter what text surrounds the value.
 * Base64 works in 3-byte groups, so a value can sit at three different alignments inside a
 * larger encoded blob. For each alignment we keep only the characters that depend on the
 * value alone.
 */
export function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    const encoded = padded.toString('base64').replace(/=+$/, '');
    const start = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    cores.push(encoded.slice(start, end));
  }
  return cores;
}

export function formsFor(canary: Canary): CanaryForm[] {
  const forms: CanaryForm[] = [];
  const seen = new Set<string>();
  const add = (form: Omit<CanaryForm, 'canary'>): void => {
    const key = `${form.caseSensitive ? 'cs' : 'ci'}:${form.caseSensitive ? form.needle : form.needle.toLowerCase()}`;
    if (!form.needle || seen.has(key)) return;
    seen.add(key);
    forms.push({ canary: canary.name, ...form });
  };
  const plain = (id: string, needle: string, label: string, exactness: 'full' | 'marker' = 'full'): void => {
    if (needle.length < MIN_PLAIN_NEEDLE) return;
    add({ id, kind: 'plain', needle: needle.toLowerCase(), caseSensitive: false, exactness, label });
  };

  const variants = normalisedVariants(canary);

  // 1. Readable text.
  if (canary.type === 'phone') {
    const national = variants.find((x) => x.id === 'national')?.text ?? canary.value.replace(/\D/g, '');
    plain('plain', national, 'as readable text');
    if (national.length === 10) {
      for (const [sepName, sep] of [['space', ' '], ['hyphen', '-']] as const) {
        plain(`plain:5-5:${sepName}`, `${national.slice(0, 5)}${sep}${national.slice(5)}`, 'as readable text, grouped 5-5');
        plain(
          `plain:3-3-4:${sepName}`,
          `${national.slice(0, 3)}${sep}${national.slice(3, 6)}${sep}${national.slice(6)}`,
          'as readable text, grouped 3-3-4',
        );
      }
    }
  } else {
    const base = canary.value.trim();
    plain('plain', base, 'as readable text');
    if (/\s/.test(base)) {
      const words = base.split(/\s+/);
      plain('plain:collapsed', words.join(' '), 'as readable text');
      plain('plain:hyphen', words.join('-'), 'as readable text, words joined with hyphens');
      plain('plain:underscore', words.join('_'), 'as readable text, words joined with underscores');
      plain('plain:plus', words.join('+'), 'as readable text, words joined with plus signs');
      plain('plain:pct20', words.join('%20'), 'as readable text, URL-encoded');
      plain('plain:nospace', words.join(''), 'as readable text, spaces removed');
    }
    if (canary.unique && canary.marker && canary.marker !== base) {
      plain('marker', canary.marker, 'in part: only the unique marker', 'marker');
    }
  }

  // 2. Base64 of the readable text, at every alignment (catches values buried in an encoded blob).
  for (const variant of variants) {
    if (variant.text.length < MIN_PLAIN_NEEDLE) continue;
    base64Cores(variant.text).forEach((core, align) => {
      if (core.length < 10) return;
      add({
        id: `base64:${variant.id}:align${align}`,
        kind: 'encoded',
        needle: core,
        caseSensitive: true,
        exactness: 'full',
        label: 'base64-encoded',
      });
      const urlSafe = core.replace(/\+/g, '-').replace(/\//g, '_');
      if (urlSafe !== core) {
        add({
          id: `base64url:${variant.id}:align${align}`,
          kind: 'encoded',
          needle: urlSafe,
          caseSensitive: true,
          exactness: 'full',
          label: 'base64url-encoded',
        });
      }
    });
  }

  // 3. Hashes of every normalised variant. This is how "advanced matching" sends emails and phones.
  for (const variant of variants) {
    for (const { algorithm, name } of HASHES) {
      const raw = digest(algorithm, variant.text);
      add({
        id: `${algorithm}:${variant.id}`,
        kind: 'hash',
        needle: raw.toString('hex'),
        caseSensitive: false,
        exactness: 'full',
        label: `as a ${name} hash of the ${canary.label} (${variant.describe})`,
      });
      if (algorithm === 'sha256') {
        const b64 = raw.toString('base64').replace(/=+$/, '');
        add({
          id: `sha256-base64:${variant.id}`,
          kind: 'hash',
          needle: b64,
          caseSensitive: true,
          exactness: 'full',
          label: `as a SHA-256 hash (base64) of the ${canary.label} (${variant.describe})`,
        });
        const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_');
        add({
          id: `sha256-base64url:${variant.id}`,
          kind: 'hash',
          needle: b64url,
          caseSensitive: true,
          exactness: 'full',
          label: `as a SHA-256 hash (base64url) of the ${canary.label} (${variant.describe})`,
        });
      }
    }
  }

  return forms;
}
