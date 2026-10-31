const path = require('node:path');

const SCREEN_MODULE = '@/features/e2ee-dev/E2eeSpikeScreen';

/**
 * En production, le module de l'écran d'auto-test E2EE est remplacé par un
 * stub vide : ni l'écran ni son import du module natif n'entrent dans le
 * bundle. La fonction est pure pour être couverte par un test.
 */
function resolveE2eeDevModule(moduleName, devToolsEnabled, projectRoot) {
  if (devToolsEnabled) return null;
  if (moduleName === SCREEN_MODULE) {
    return path.join(projectRoot, 'src/features/e2ee-dev/E2eeSpikeScreen.prod.tsx');
  }
  return null;
}

module.exports = { resolveE2eeDevModule, SCREEN_MODULE };
