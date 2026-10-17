import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ACCENT = [0x3c / 255, 0x87 / 255, 0xf7 / 255, 1];
const WHITE = [1, 1, 1, 1];
const BLACK = [0, 0, 0, 1];

function roundRect(cx, cy, hw, hh, r, color) {
  return {
    color,
    test(x, y) {
      const dx = Math.abs(x - cx) - (hw - r);
      const dy = Math.abs(y - cy) - (hh - r);
      const ox = Math.max(dx, 0);
      const oy = Math.max(dy, 0);
      const d = Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
      return d <= 0;
    },
  };
}

function circle(cx, cy, r, color) {
  return { color, test: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r };
}

function poly(points, color) {
  return {
    color,
    test(x, y) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    },
  };
}

function erase(shape) {
  return { ...shape, erase: true };
}

function render(size, layers, samples = 3) {
  const data = Buffer.alloc(size * size * 4);
  const n = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = px + (sx + 0.5) / samples;
          const y = py + (sy + 0.5) / samples;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const layer of layers) {
            if (layer.test(x, y)) {
              if (layer.erase) {
                cr = 0;
                cg = 0;
                cb = 0;
                ca = 0;
                continue;
              }
              const [lr, lg, lb, la] = layer.color;
              const na = la + ca * (1 - la);
              const keep = ca * (1 - la);
              if (na > 0) {
                cr = (lr * la + cr * keep) / na;
                cg = (lg * la + cg * keep) / na;
                cb = (lb * la + cb * keep) / na;
              }
              ca = na;
            }
          }
          sumR += cr * ca;
          sumG += cg * ca;
          sumB += cb * ca;
          sumA += ca;
        }
      }
      const offset = (py * size + px) * 4;
      if (sumA > 0) {
        data[offset] = Math.round((sumR / sumA) * 255);
        data[offset + 1] = Math.round((sumG / sumA) * 255);
        data[offset + 2] = Math.round((sumB / sumA) * 255);
        data[offset + 3] = Math.round((sumA / n) * 255);
      }
    }
  }
  return data;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function writePng(path, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  console.log(`${path} (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

function bubbleLayers(size, scale, options = {}) {
  const k = (size / 1024) * scale;
  const cx = size / 2;
  const cy = size / 2 - 10 * k;
  const dot = options.dots ?? ACCENT;
  const bubble = options.bubble ?? WHITE;
  return [
    roundRect(cx, cy, 252 * k, 192 * k, 92 * k, bubble),
    poly(
      [
        [cx - 220 * k, cy + 108 * k],
        [cx - 82 * k, cy + 156 * k],
        [cx - 220 * k, cy + 316 * k],
      ],
      bubble,
    ),
    circle(cx - 80 * k, cy, 34 * k, options.eraseDots ? BLACK : dot),
    circle(cx, cy, 34 * k, options.eraseDots ? BLACK : dot),
    circle(cx + 80 * k, cy, 34 * k, options.eraseDots ? BLACK : dot),
  ];
}

const images = join(root, 'assets', 'images');

writePng(
  join(images, 'icon.png'),
  1024,
  render(1024, [
    roundRect(512, 512, 512, 512, 58, ACCENT),
    ...bubbleLayers(1024, 1),
  ]),
);

writePng(
  join(images, 'favicon.png'),
  48,
  render(
    48,
    [roundRect(24, 24, 24, 24, 10, ACCENT), ...bubbleLayers(48, 1).slice(0, 2)],
    4,
  ),
);

writePng(
  join(images, 'splash-icon.png'),
  512,
  render(512, bubbleLayers(512, 1), 4),
);

writePng(
  join(images, 'android-icon-foreground.png'),
  512,
  render(512, bubbleLayers(512, 0.72), 4),
);

writePng(
  join(images, 'android-icon-monochrome.png'),
  512,
  render(
    512,
    bubbleLayers(512, 0.72, { bubble: BLACK, dots: BLACK, eraseDots: true }).map(
      (layer, index) => (index >= 2 ? erase(layer) : layer),
    ),
    4,
  ),
);
