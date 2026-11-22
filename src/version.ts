import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};

export const TOOL = { name: pkg.name, version: pkg.version };
export const PLAYWRIGHT_VERSION = pkg.dependencies.playwright ?? 'unknown';
