import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Les tests mobiles couvrent la logique pure des appels (SDP, qualité,
 * reconnexion). Les composants React Native ne sont pas montés ici : c'est
 * `tsc` + les tests sur appareil qui couvrent l'interface.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
