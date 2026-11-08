import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Les suites e2e partagent la même base : on coupe la reprise périodique
    // du journal (chaque suite pilote son worker explicitement), sinon une
    // instance peut délivrer les effets d'une autre.
    env: { MESSAGE_EVENTS_SWEEP_MS: '600000' },
  },
});
