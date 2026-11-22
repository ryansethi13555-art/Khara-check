import { promises as dns } from 'node:dns';

/**
 * Looks up the DNS aliases (CNAME chains) of hostnames, so that a hostname that looks like the
 * site's own but points at another company's collection server can be recognised. The result is
 * stored in the evidence, so the analysis stays a pure function of the folder.
 */
export async function resolveAliases(hosts: string[], timeoutMs = 2500): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const one = async (host: string): Promise<void> => {
    const chain: string[] = [];
    let name = host;
    for (let i = 0; i < 6; i++) {
      const next = await Promise.race([
        dns.resolveCname(name).then((r) => r[0]?.toLowerCase().replace(/\.$/, '')).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);
      if (!next || chain.includes(next)) break;
      chain.push(next);
      name = next;
    }
    if (chain.length) out[host] = chain;
  };
  await Promise.all([...new Set(hosts)].sort().map(one));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Hostnames in a capture that carry the site's own name: the only ones whose aliases matter. */
export function ownHosts(urls: string[], isOwn: (host: string) => boolean): string[] {
  const hosts = new Set<string>();
  for (const u of urls) {
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (h && isOwn(h) && !/^(localhost|\d+\.\d+\.\d+\.\d+)$/.test(h)) hosts.add(h);
    } catch {
      // not a URL
    }
  }
  return [...hosts];
}
