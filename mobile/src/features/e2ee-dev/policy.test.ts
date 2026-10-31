import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { isE2eeDevToolsEnabled } from './policy';

const requireCjs = createRequire(import.meta.url);
const { resolveE2eeDevModule } = requireCjs('../../../metro.e2ee-dev.cjs') as {
  resolveE2eeDevModule: (moduleName: string, enabled: boolean, root: string) => string | null;
};

describe('e2ee dev tools', () => {
  it('reste désactivé hors développement ou sans opt-in', () => {
    expect(isE2eeDevToolsEnabled(false, '1')).toBe(false);
    expect(isE2eeDevToolsEnabled(true, undefined)).toBe(false);
    expect(isE2eeDevToolsEnabled(true, '0')).toBe(false);
    expect(isE2eeDevToolsEnabled(true, '1')).toBe(true);
  });

  it('autorise uniquement la build spike explicite hors développement', () => {
    expect(isE2eeDevToolsEnabled(false, '1', '1')).toBe(true);
    expect(isE2eeDevToolsEnabled(false, '1', '0')).toBe(false);
    expect(isE2eeDevToolsEnabled(false, undefined, '1')).toBe(false);
  });

  it('remplace l’écran par le stub hors développement', () => {
    expect(resolveE2eeDevModule('@/features/e2ee-dev/E2eeSpikeScreen', true, '/app')).toBeNull();
    expect(resolveE2eeDevModule('@/features/e2ee-dev/E2eeSpikeScreen', false, '/app')).toBe(
      '/app/src/features/e2ee-dev/E2eeSpikeScreen.prod.tsx',
    );
    expect(resolveE2eeDevModule('@/ui/button', false, '/app')).toBeNull();
  });
});
