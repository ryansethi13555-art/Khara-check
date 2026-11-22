import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Browser runs are heavy; a few at a time keeps timings honest on small machines.
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    pool: 'forks',
  },
});
