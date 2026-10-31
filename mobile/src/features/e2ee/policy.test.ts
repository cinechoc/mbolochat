import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isE2eeEnabled } from './policy';

const appConfig = JSON.parse(
  readFileSync(new URL('../../../app.json', import.meta.url), 'utf8'),
) as {
  expo: {
    android?: { allowBackup?: boolean };
    plugins?: (string | [string, Record<string, unknown>])[];
  };
};

describe('drapeau E2EE et sauvegarde Android', () => {
  it('est désactivé par défaut', () => {
    expect(isE2eeEnabled(undefined)).toBe(false);
    expect(isE2eeEnabled('0')).toBe(false);
    expect(isE2eeEnabled('1')).toBe(true);
  });

  it('exclut la sauvegarde Android', () => {
    expect(appConfig.expo.android?.allowBackup).toBe(false);
  });

  it('compile SQLCipher dans expo-sqlite', () => {
    const sqlite = appConfig.expo.plugins?.find(
      (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-sqlite',
    );
    expect(Array.isArray(sqlite)).toBe(true);
    expect(Array.isArray(sqlite) ? sqlite[1]?.useSQLCipher : null).toBe(true);
  });
});
