import type { Canary, CanaryType } from '../types.js';
import { pick, type Rng } from '../util/random.js';

/** How a journey file describes one canary. */
export interface CanarySpec {
  type: CanaryType;
  /** For search terms and free text: the realistic part, e.g. "metformin 500". */
  base?: string;
  /** Use exactly this value instead of generating one. */
  value?: string;
  /** Read the value from this environment variable (keeps real phone numbers out of journey files). */
  valueFromEnv?: string;
  /** Add a random marker so the value exists nowhere else. Default: true for generated values. */
  unique?: boolean;
  /** Email domain for generated addresses. Default: example.com (reserved, never deliverable). */
  domain?: string;
  /** Country calling code for phones, digits only. Default "91". */
  countryCode?: string;
  /** Label used in reports. */
  label?: string;
}

/** Consonants only, so a marker never spells a word and never looks like a real search. */
const MARKER_ALPHABET = 'bcdfghjkmnpqrstvwxz';
const MARKER_LENGTH = 7;

const DEFAULT_LABEL: Record<CanaryType, string> = {
  'search-term': 'search term',
  email: 'email address',
  phone: 'phone number',
  text: 'typed text',
};

export interface GenerateOptions {
  rng: Rng;
  /** Generated phone numbers can belong to real people, so they are only allowed in sandbox runs. */
  allowGeneratedPhone: boolean;
  env?: NodeJS.ProcessEnv;
}

export function generateCanary(name: string, spec: CanarySpec, opts: GenerateOptions): Canary {
  const label = spec.label ?? DEFAULT_LABEL[spec.type];
  const countryCode = spec.type === 'phone' ? (spec.countryCode ?? '91').replace(/\D/g, '') : undefined;

  const supplied = spec.value ?? (spec.valueFromEnv ? (opts.env ?? process.env)[spec.valueFromEnv] : undefined);
  if (spec.valueFromEnv && supplied === undefined) {
    throw new Error(
      `Canary "${name}" reads its value from the environment variable ${spec.valueFromEnv}, which is not set.`,
    );
  }
  if (supplied !== undefined) {
    const value = String(supplied);
    if (value.trim().length < 6) {
      throw new Error(`Canary "${name}" is too short to be searched for safely (need at least 6 characters).`);
    }
    return {
      name,
      type: spec.type,
      label,
      value,
      // A supplied value is taken at its word only if the journey says it is unique.
      unique: spec.unique === true,
      origin: 'supplied',
      ...(countryCode ? { countryCode } : {}),
    };
  }

  const wantMarker = spec.unique !== false;
  const marker = pick(opts.rng, MARKER_ALPHABET, MARKER_LENGTH);

  switch (spec.type) {
    case 'search-term':
    case 'text': {
      const base = (spec.base ?? '').trim();
      if (!wantMarker) {
        if (base.length < 6) {
          throw new Error(`Canary "${name}" needs a "base" of at least 6 characters when "unique" is false.`);
        }
        return { name, type: spec.type, label, value: base, unique: false, origin: 'generated' };
      }
      const value = base ? `${base} ${marker}` : marker;
      return { name, type: spec.type, label, value, unique: true, marker, origin: 'generated' };
    }
    case 'email': {
      const domain = spec.domain ?? 'example.com';
      return {
        name,
        type: 'email',
        label,
        value: `khara.${marker}@${domain}`,
        unique: true,
        marker,
        origin: 'generated',
      };
    }
    case 'phone': {
      if (!opts.allowGeneratedPhone) {
        throw new Error(
          `Canary "${name}": Khara Check does not invent phone numbers for live sites, because a random number ` +
            `may belong to a real person who would then receive the site's messages. ` +
            `Supply your own test number with "value" or "valueFromEnv".`,
        );
      }
      // Ten digits in the Indian mobile shape. Only ever typed into a sandboxed page.
      const first = '6789'[opts.rng.int(4)];
      const rest = pick(opts.rng, '0123456789', 9);
      return {
        name,
        type: 'phone',
        label,
        value: `${first}${rest}`,
        unique: true,
        origin: 'generated',
        countryCode: countryCode ?? '91',
      };
    }
  }
}
