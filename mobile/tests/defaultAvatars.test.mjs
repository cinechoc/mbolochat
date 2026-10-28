import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function png(pathname) {
  const data = readFileSync(path.join(root, pathname));
  assert.equal(data.toString('ascii', 1, 4), 'PNG', `${pathname} doit être un PNG`);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colorType: data[25],
    hash: createHash('sha256').update(data).digest('hex'),
  };
}

test('les trois avatars par défaut sont des PNG 512x512 transparents et distincts', () => {
  const avatars = [
    png('assets/images/avatars/default-neutral.png'),
    png('assets/images/avatars/default-male.png'),
    png('assets/images/avatars/default-female.png'),
  ];

  for (const avatar of avatars) {
    assert.equal(avatar.width, 512);
    assert.equal(avatar.height, 512);
    assert.equal(avatar.bitDepth, 8);
    assert.equal(avatar.colorType, 6, 'RGBA attendu (fond transparent)');
  }

  assert.equal(new Set(avatars.map((avatar) => avatar.hash)).size, 3);
});

test('les ressources Android utilisent le logo officiel et restent cohérentes', () => {
  const icon = png('assets/images/icon.png');
  assert.equal(icon.width, 1024);
  assert.equal(icon.height, 1024);
  assert.equal(icon.colorType, 2, 'icône legacy opaque attendue');

  const logoMark = png('assets/images/logo-mark.png');
  assert.equal(logoMark.width, 256);
  assert.equal(logoMark.height, 256);
  assert.equal(logoMark.colorType, 2, 'logo d’interface opaque attendu');

  for (const name of [
    'assets/images/android-icon-foreground.png',
    'assets/images/android-icon-monochrome.png',
    'assets/images/splash-icon.png',
  ]) {
    const image = png(name);
    assert.equal(image.width, 512, name);
    assert.equal(image.height, 512, name);
    assert.equal(image.colorType, 6, `${name} doit avoir un fond transparent`);
  }

  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(app.expo.icon, './assets/images/icon.png');
  assert.equal(app.expo.android.adaptiveIcon.backgroundColor, '#0B1428');
  assert.equal(
    app.expo.android.adaptiveIcon.foregroundImage,
    './assets/images/android-icon-foreground.png',
  );
  assert.equal(
    app.expo.android.adaptiveIcon.monochromeImage,
    './assets/images/android-icon-monochrome.png',
  );
});
