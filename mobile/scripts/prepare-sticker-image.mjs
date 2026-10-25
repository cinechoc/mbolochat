#!/usr/bin/env node
/**
 * Prépare une illustration générée pour le pack de stickers :
 * retire le fond clair, supprime le liseré blanc des bords, rogne les marges
 * inutiles et exporte un PNG 512 × 512 à vrai canal alpha.
 *
 *   node scripts/prepare-sticker-image.mjs <entrée.png> <sortie.png>
 */
import sharp from 'sharp';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('Usage : node scripts/prepare-sticker-image.mjs <entrée.png> <sortie.png>');
  process.exit(1);
}

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const N = W * H;
const alpha = new Uint8Array(N).fill(255);

const samples = [];
for (const [x, y] of [
  [0, 0],
  [W - 1, 0],
  [0, H - 1],
  [W - 1, H - 1],
  [Math.floor(W / 2), 0],
  [Math.floor(W / 2), H - 1],
  [0, Math.floor(H / 2)],
  [W - 1, Math.floor(H / 2)],
]) {
  const p = (y * W + x) * 4;
  samples.push([data[p], data[p + 1], data[p + 2]]);
}
const bg = samples.reduce(
  (acc, color) => [
    acc[0] + color[0] / samples.length,
    acc[1] + color[1] / samples.length,
    acc[2] + color[2] / samples.length,
  ],
  [0, 0, 0],
);

function isBackground(index) {
  const p = index * 4;
  const r = data[p];
  const g = data[p + 1];
  const b = data[p + 2];
  const distance = Math.max(
    Math.abs(r - bg[0]),
    Math.abs(g - bg[1]),
    Math.abs(b - bg[2]),
  );
  return (r + g + b) / 3 >= 218 && distance <= 42;
}

// Remplissage depuis les bords uniquement : les blancs intérieurs (yeux,
// reflets, dents) sont préservés car ils ne sont pas connectés au fond.
const queue = new Int32Array(N);
const seen = new Uint8Array(N);
let head = 0;
let tail = 0;
const push = (index) => {
  if (seen[index] || !isBackground(index)) return;
  seen[index] = 1;
  queue[tail++] = index;
};
for (let x = 0; x < W; x += 1) {
  push(x);
  push((H - 1) * W + x);
}
for (let y = 0; y < H; y += 1) {
  push(y * W);
  push(y * W + W - 1);
}
while (head < tail) {
  const index = queue[head++];
  const x = index % W;
  const y = (index / W) | 0;
  if (x > 0) push(index - 1);
  if (x < W - 1) push(index + 1);
  if (y > 0) push(index - W);
  if (y < H - 1) push(index + W);
}
for (let index = 0; index < N; index += 1) {
  if (seen[index]) alpha[index] = 0;
}

// Le fond clair laisse un liseré anti-aliasé sur les bords. On recolore les
// deux pixels extérieurs avec la couleur intérieure la plus proche.
const boundary = new Uint8Array(N);
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const index = y * W + x;
    if (alpha[index] === 0) continue;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && alpha[ny * W + nx] === 0) {
          edge = true;
          break;
        }
      }
    }
    if (edge) boundary[index] = 1;
  }
}
const rgb = Buffer.from(data);
for (let pass = 0; pass < 2; pass += 1) {
  const updates = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const index = y * W + x;
      if (alpha[index] === 0 || !boundary[index]) continue;
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let count = 0;
      for (let radius = 2; radius <= 5 && count === 0; radius += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (Math.abs(dx) < radius && Math.abs(dy) < radius) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nIndex = ny * W + nx;
            if (alpha[nIndex] === 0 || boundary[nIndex]) continue;
            const p = nIndex * 4;
            rs += data[p];
            gs += data[p + 1];
            bs += data[p + 2];
            count += 1;
          }
        }
        if (count) break;
      }
      if (count) updates.push([index, rs / count, gs / count, bs / count]);
    }
  }
  for (const [index, r, g, b] of updates) {
    const p = index * 4;
    rgb[p] = Math.round(r);
    rgb[p + 1] = Math.round(g);
    rgb[p + 2] = Math.round(b);
  }
}

const out = Buffer.alloc(N * 4);
let transparent = 0;
for (let index = 0; index < N; index += 1) {
  const p = index * 4;
  out[p] = rgb[p];
  out[p + 1] = rgb[p + 1];
  out[p + 2] = rgb[p + 2];
  out[p + 3] = alpha[index];
  if (alpha[index] === 0) transparent += 1;
}
const ratio = transparent / N;
if (ratio < 0.15 || ratio > 0.97) {
  throw new Error(`Détourage douteux : ${(ratio * 100).toFixed(1)} % transparent`);
}

const SIZE = 512;
const MARGIN = 20;

await sharp(out, { raw: { width: W, height: H, channels: 4 } })
  .trim({ threshold: 1 })
  .resize(SIZE - MARGIN * 2, SIZE - MARGIN * 2, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .extend({
    top: MARGIN,
    bottom: MARGIN,
    left: MARGIN,
    right: MARGIN,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png({ compressionLevel: 9, palette: true, quality: 95, colours: 256 })
  .toFile(output);

console.log(
  `${output} : fond ${bg.map((value) => Math.round(value)).join(',')} · ` +
    `${(ratio * 100).toFixed(1)} % transparent`,
);
