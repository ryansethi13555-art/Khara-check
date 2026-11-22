import { parse } from 'tldts';

/**
 * Registrable domain ("eTLD+1") of a host: www.facebook.com -> facebook.com,
 * shop.example.co.in -> example.co.in. IP addresses and localhost are returned as they are.
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const parsed = parse(h, { allowPrivateDomains: false });
  if (parsed.isIp) return h;
  return parsed.domain ?? h;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith('.' + d);
}
