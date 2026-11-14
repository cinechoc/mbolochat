/**
 * Code de sécurité d'identité.
 *
 * Ce module ne touche ni aux sessions Olm, ni aux clés privées : il met en
 * forme deux clés **publiques** déjà lues par les accesseurs existants, puis
 * calcule un SHA-256 local. Aucune donnée n'est envoyée au serveur.
 */

export const SAFETY_NUMBER_DOMAIN = 'MboloChat safety number v1';
const QR_PREFIX = 'mbolo-identity-v1:';

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    if (point <= 0x7f) {
      bytes.push(point);
    } else if (point <= 0x7ff) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** SHA-256 standard, sans dépendance native (Hermes n'expose pas WebCrypto). */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  padded[paddedLength - 8] = (high >>> 24) & 0xff;
  padded[paddedLength - 7] = (high >>> 16) & 0xff;
  padded[paddedLength - 6] = (high >>> 8) & 0xff;
  padded[paddedLength - 5] = high & 0xff;
  padded[paddedLength - 4] = (low >>> 24) & 0xff;
  padded[paddedLength - 3] = (low >>> 16) & 0xff;
  padded[paddedLength - 2] = (low >>> 8) & 0xff;
  padded[paddedLength - 1] = low & 0xff;

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] =
        ((padded[base] << 24) |
          (padded[base + 1] << 16) |
          (padded[base + 2] << 8) |
          padded[base + 3]) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  hash.forEach((word, index) => {
    digest[index * 4] = (word >>> 24) & 0xff;
    digest[index * 4 + 1] = (word >>> 16) & 0xff;
    digest[index * 4 + 2] = (word >>> 8) & 0xff;
    digest[index * 4 + 3] = word & 0xff;
  });
  return digest;
}

export function sha256Hex(value: string): string {
  return [...sha256Bytes(utf8Bytes(value))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Entrée canonique : domaine fixe + clés triées, chacune préfixée par sa taille. */
export function canonicalIdentityInput(first: string, second: string): string {
  const keys = [first, second].sort();
  return `${SAFETY_NUMBER_DOMAIN}\u0000${keys
    .map((key) => `${utf8Bytes(key).length}:${key}`)
    .join('\u0000')}`;
}

export function isIdentityKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

/** Code à 60 chiffres, identique des deux côtés quel que soit l'ordre. */
export function computeSafetyNumber(first: string, second: string): string {
  if (!isIdentityKey(first) || !isIdentityKey(second)) {
    throw new Error('Clé d’identité invalide');
  }
  const digest = sha256Bytes(utf8Bytes(canonicalIdentityInput(first, second)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return (BigInt(`0x${hex}`) % 10n ** 60n).toString().padStart(60, '0');
}

export function formatSafetyNumber(code: string): string {
  if (!/^\d{60}$/.test(code)) return '';
  return code.match(/.{5}/g)?.join(' ') ?? '';
}

export function safetyNumberQrPayload(code: string): string {
  if (!/^\d{60}$/.test(code)) throw new Error('Code de sécurité invalide');
  return `${QR_PREFIX}${code}`;
}

/** Accepte le format QR complet ou les 60 chiffres nus, avec espaces. */
export function normalizeScannedSafetyNumber(value: string): string | null {
  const raw = value.trim();
  const body = raw.startsWith(QR_PREFIX) ? raw.slice(QR_PREFIX.length) : raw;
  const digits = body.replace(/\s/g, '');
  return /^\d{60}$/.test(digits) ? digits : null;
}
