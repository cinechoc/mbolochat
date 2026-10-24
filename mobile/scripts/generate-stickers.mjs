#!/usr/bin/env node
/**
 * Génère le pack de démonstration « Mbolo Originals » (stickers PNG originaux).
 *
 * Les illustrations sont entièrement dessinées en SVG puis rasterisées en PNG
 * 512 × 512 avec fond transparent. Relancer ce script régénère les fichiers de
 * mobile/assets/stickers/mbolo-originals/ sans dépendance à un service externe.
 *
 *   node scripts/generate-stickers.mjs
 *
 * Dépendance système : rsvg-convert (librsvg). Aucune dépendance npm.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'stickers', 'mbolo-originals');
const svgDir = join(outDir, 'svg');

const INK = '#30263D';
const EYE = '#35263D';
const WHITE = '#FFFFFF';

const palettes = {
  soleil: ['#FFE27A', '#F4A62A', '#D98416'],
  corail: ['#FFB098', '#F06A5F', '#D94C48'],
  rose: ['#FFC1D4', '#F26D96', '#D94F7B'],
  ciel: ['#A9E1FF', '#55ABEA', '#3679C4'],
  nuit: ['#BCC5FF', '#7583E8', '#5157BF'],
  lavande: ['#E3C9FF', '#AE7AEB', '#8150C2'],
  menthe: ['#C4F5D1', '#64CE88', '#3C9D64'],
  banane: ['#FFF0A3', '#FFC93C', '#E4A013'],
  peche: ['#FFDCC6', '#F4A982', '#D77F5B'],
  chocolat: ['#E5C4A8', '#B98A64', '#8E6142'],
};

function gradient(id, [light, mid, dark]) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0.25" y2="1">
    <stop offset="0" stop-color="${light}"/>
    <stop offset="0.55" stop-color="${mid}"/>
    <stop offset="1" stop-color="${dark}"/>
  </linearGradient>`;
}

/** Tête-buste ronde, la base commune de tous les personnages. */
function body(id, colors) {
  return `<path d="M256 82C357 82 420 159 420 262C420 366 355 438 256 438C157 438 92 366 92 262C92 159 155 82 256 82Z" fill="url(#${id})" stroke="${INK}" stroke-width="11" stroke-linejoin="round"/>`;
}

function feet() {
  return `<ellipse cx="184" cy="424" rx="47" ry="25" fill="#F7EFE8" stroke="${INK}" stroke-width="9"/>
  <ellipse cx="328" cy="424" rx="47" ry="25" fill="#F7EFE8" stroke="${INK}" stroke-width="9"/>`;
}

function highlight() {
  return `<ellipse cx="174" cy="156" rx="60" ry="28" fill="${WHITE}" opacity=".24" transform="rotate(-28 174 156)"/>
  <ellipse cx="345" cy="215" rx="20" ry="49" fill="${WHITE}" opacity=".10" transform="rotate(22 345 215)"/>`;
}

function blush() {
  return `<ellipse cx="164" cy="316" rx="30" ry="15" fill="#F2607E" opacity=".38"/>
  <ellipse cx="348" cy="316" rx="30" ry="15" fill="#F2607E" opacity=".38"/>`;
}

function ears(kind, colors) {
  const [, mid, dark] = colors;
  switch (kind) {
    case 'cat':
      return `<path d="M126 154L148 50L224 106Z" fill="url(#ear)" stroke="${INK}" stroke-width="10" stroke-linejoin="round"/>
        <path d="M386 154L364 50L288 106Z" fill="url(#ear)" stroke="${INK}" stroke-width="10" stroke-linejoin="round"/>
        <path d="M151 105L159 72L190 104Z" fill="#FF9BB6"/>
        <path d="M361 105L353 72L322 104Z" fill="#FF9BB6"/>`;
    case 'dog':
      return `<ellipse cx="118" cy="224" rx="49" ry="96" fill="${dark}" stroke="${INK}" stroke-width="10" transform="rotate(17 118 224)"/>
        <ellipse cx="394" cy="224" rx="49" ry="96" fill="${dark}" stroke="${INK}" stroke-width="10" transform="rotate(-17 394 224)"/>`;
    case 'panda':
      return `<circle cx="146" cy="148" r="57" fill="#3A3042" stroke="${INK}" stroke-width="9"/>
        <circle cx="366" cy="148" r="57" fill="#3A3042" stroke="${INK}" stroke-width="9"/>`;
    case 'bunny':
      return `<ellipse cx="182" cy="71" rx="42" ry="96" fill="url(#ear)" stroke="${INK}" stroke-width="10" transform="rotate(-10 182 71)"/>
        <ellipse cx="330" cy="71" rx="42" ry="96" fill="url(#ear)" stroke="${INK}" stroke-width="10" transform="rotate(10 330 71)"/>
        <ellipse cx="182" cy="77" rx="18" ry="65" fill="#FFB6CC" transform="rotate(-10 182 77)"/>
        <ellipse cx="330" cy="77" rx="18" ry="65" fill="#FFB6CC" transform="rotate(10 330 77)"/>`;
    case 'frog':
      return `<circle cx="160" cy="134" r="62" fill="${mid}" stroke="${INK}" stroke-width="10"/>
        <circle cx="352" cy="134" r="62" fill="${mid}" stroke="${INK}" stroke-width="10"/>
        <circle cx="160" cy="130" r="32" fill="${WHITE}"/>
        <circle cx="352" cy="130" r="32" fill="${WHITE}"/>`;
    case 'parrot':
      return `<path d="M206 100C186 40 213 25 244 71C252 20 286 20 292 70C318 33 350 45 327 104Z" fill="url(#ear)" stroke="${INK}" stroke-width="9" stroke-linejoin="round"/>`;
    default:
      return '';
  }
}

function eyes(kind) {
  const open = (cx) => `<ellipse cx="${cx}" cy="238" rx="29" ry="34" fill="${EYE}"/>
    <ellipse cx="${cx - 9}" cy="226" rx="10" ry="12" fill="${WHITE}"/>
    <circle cx="${cx + 10}" cy="249" r="5" fill="${WHITE}" opacity=".85"/>`;
  const happy = (cx) => `<path d="M${cx - 30} 242C${cx - 16} 220 ${cx + 16} 220 ${cx + 30} 242" fill="none" stroke="${EYE}" stroke-width="11" stroke-linecap="round"/>`;
  switch (kind) {
    case 'happy':
      return happy(205) + happy(307);
    case 'laugh':
      return `<path d="M172 246C188 218 220 218 236 246" fill="none" stroke="${EYE}" stroke-width="12" stroke-linecap="round"/>
        <path d="M276 246C292 218 324 218 340 246" fill="none" stroke="${EYE}" stroke-width="12" stroke-linecap="round"/>`;
    case 'heart':
      return `<path d="M205 218C188 197 156 217 178 249L205 272L232 249C254 217 222 197 205 218Z" fill="#F34D6D" stroke="${INK}" stroke-width="7"/>
        <path d="M308 218C291 197 259 217 281 249L308 272L335 249C357 217 325 197 308 218Z" fill="#F34D6D" stroke="${INK}" stroke-width="7"/>`;
    case 'wide':
      return `<circle cx="205" cy="238" r="38" fill="${WHITE}" stroke="${INK}" stroke-width="8"/>
        <circle cx="308" cy="238" r="38" fill="${WHITE}" stroke="${INK}" stroke-width="8"/>
        <circle cx="205" cy="241" r="19" fill="${EYE}"/>
        <circle cx="308" cy="241" r="19" fill="${EYE}"/>
        <circle cx="198" cy="234" r="6" fill="${WHITE}"/>
        <circle cx="301" cy="234" r="6" fill="${WHITE}"/>`;
    case 'sad':
      return `<ellipse cx="205" cy="244" rx="25" ry="29" fill="${EYE}"/>
        <ellipse cx="307" cy="244" rx="25" ry="29" fill="${EYE}"/>
        <path d="M165 208L212 220M347 208L300 220" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
        <ellipse cx="194" cy="235" rx="8" ry="10" fill="${WHITE}"/>
        <ellipse cx="296" cy="235" rx="8" ry="10" fill="${WHITE}"/>`;
    case 'angry':
      return `<ellipse cx="205" cy="245" rx="24" ry="27" fill="${EYE}"/>
        <ellipse cx="307" cy="245" rx="24" ry="27" fill="${EYE}"/>
        <path d="M162 208L220 230M350 208L292 230" stroke="${INK}" stroke-width="13" stroke-linecap="round"/>`;
    case 'shy':
      return `<path d="M181 238C190 226 207 226 216 238" fill="none" stroke="${EYE}" stroke-width="10" stroke-linecap="round"/>
        <path d="M298 238C307 226 324 226 333 238" fill="none" stroke="${EYE}" stroke-width="10" stroke-linecap="round"/>`;
    case 'wink':
      return `${open(205)}<path d="M278 240C292 226 320 226 336 244" fill="none" stroke="${EYE}" stroke-width="11" stroke-linecap="round"/>`;
    case 'sleep':
      return `<path d="M174 242C191 228 220 228 237 242" fill="none" stroke="${EYE}" stroke-width="11" stroke-linecap="round"/>
        <path d="M275 242C292 228 321 228 338 242" fill="none" stroke="${EYE}" stroke-width="11" stroke-linecap="round"/>`;
    case 'determined':
      return `${open(205)}${open(307)}<path d="M164 205L222 220M348 205L290 220" stroke="${INK}" stroke-width="11" stroke-linecap="round"/>`;
    case 'sparkle':
      return `<path d="M205 208L214 234L240 243L214 252L205 278L196 252L170 243L196 234Z" fill="${WHITE}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
        <path d="M308 208L317 234L343 243L317 252L308 278L299 252L273 243L299 234Z" fill="${WHITE}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>`;
    default:
      return open(205) + open(307);
  }
}

function mouth(kind) {
  switch (kind) {
    case 'smile':
      return `<path d="M220 304C237 326 275 326 292 304" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>`;
    case 'grin':
      return `<path d="M203 298C225 343 287 343 309 298Z" fill="#7C2E43" stroke="${INK}" stroke-width="9" stroke-linejoin="round"/>
        <path d="M224 315C242 330 270 330 288 315Z" fill="#FF8FA3"/>`;
    case 'laugh':
      return `<path d="M196 294C216 368 296 368 316 294Z" fill="#7C2E43" stroke="${INK}" stroke-width="9" stroke-linejoin="round"/>
        <path d="M235 344C246 328 266 328 277 344C270 360 242 360 235 344Z" fill="#FF8FA3"/>`;
    case 'small':
      return `<path d="M238 306C247 316 265 316 274 306" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>`;
    case 'frown':
      return `<path d="M220 318C239 298 273 298 292 318" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>`;
    case 'grit':
      return `<path d="M216 300H296C292 331 220 331 216 300Z" fill="${WHITE}" stroke="${INK}" stroke-width="9" stroke-linejoin="round"/>
        <path d="M216 300H296M256 301V329M233 302L228 328M279 302L284 328" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
    case 'o':
      return `<ellipse cx="256" cy="315" rx="26" ry="32" fill="#7C2E43" stroke="${INK}" stroke-width="9"/>`;
    case 'tongue':
      return `<path d="M220 302C237 324 275 324 292 302" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>
        <path d="M240 314C240 342 272 342 272 314Z" fill="#FF7E9D" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>`;
    case 'smirk':
      return `<path d="M224 307C247 326 282 320 294 300" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>`;
    default:
      return '';
  }
}

function sparkle(x, y, size = 18, color = '#FFF3B0') {
  return `<path d="M${x} ${y - size}L${x + size * 0.3} ${y - size * 0.3}L${x + size} ${y}L${x + size * 0.3} ${y + size * 0.3}L${x} ${y + size}L${x - size * 0.3} ${y + size * 0.3}L${x - size} ${y}L${x - size * 0.3} ${y - size * 0.3}Z" fill="${color}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`;
}

function heart(x, y, scale = 1, color = '#F34D6D') {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M0 18C-34 -8 -60 24 -28 52L0 76L28 52C60 24 34 -8 0 18Z" fill="${color}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <ellipse cx="-19" cy="20" rx="7" ry="10" fill="${WHITE}" opacity=".5" transform="rotate(-30 -19 20)"/>
  </g>`;
}

function teardrop(x, y, scale = 1, color = '#8ED8FF') {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M0 0C-16 24 -24 38 -24 50C-24 65 -13 76 0 76C13 76 24 65 24 50C24 38 16 24 0 0Z" fill="${color}" stroke="${INK}" stroke-width="6"/>
    <ellipse cx="-7" cy="47" rx="5" ry="9" fill="${WHITE}" opacity=".7"/>
  </g>`;
}

function arm(x, y, rotation, colors) {
  return `<ellipse cx="${x}" cy="${y}" rx="30" ry="55" fill="${colors[1]}" stroke="${INK}" stroke-width="10" transform="rotate(${rotation} ${x} ${y})"/>`;
}

function confetti() {
  const colors = ['#F34D6D', '#FFC93C', '#55ABEA', '#64CE88', '#AE7AEB'];
  const bits = [];
  for (let i = 0; i < 12; i += 1) {
    const angle = (Math.PI * 2 * i) / 12;
    const x = 256 + Math.cos(angle) * (188 + (i % 3) * 12);
    const y = 236 + Math.sin(angle) * (180 + (i % 2) * 10);
    bits.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="13" height="7" rx="3" fill="${colors[i % colors.length]}" stroke="${INK}" stroke-width="3" transform="rotate(${i * 29} ${x.toFixed(1)} ${y.toFixed(1)})"/>`,
    );
  }
  return bits.join('');
}

function steam() {
  return `<path d="M120 140C96 114 122 90 106 65" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" opacity=".65"/>
    <path d="M392 140C416 114 390 90 406 65" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" opacity=".65"/>`;
}

function zzz() {
  return `<g fill="#7B6FD6" stroke="${INK}" stroke-width="5" stroke-linejoin="round">
    <path d="M356 126H398L356 174H402V190H348V174L390 142H356Z"/>
    <path d="M408 76H442L408 116H446V130H400V116L434 90H400Z" transform="scale(.9) translate(48 6)"/>
  </g>`;
}

function moon() {
  return `<path d="M386 84C348 96 330 136 342 170C352 200 382 218 412 212C391 238 352 246 321 229C285 209 272 164 292 128C310 96 350 79 386 84Z" fill="#FFF0A3" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>`;
}

function cap() {
  return `<path d="M128 156C122 76 190 30 256 30C322 30 390 76 384 156C352 132 160 132 128 156Z" fill="url(#ear)" stroke="${INK}" stroke-width="10" stroke-linejoin="round"/>
    <path d="M120 154C156 132 356 132 392 154" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>
    <circle cx="386" cy="114" r="24" fill="${WHITE}" stroke="${INK}" stroke-width="8"/>
    <path d="M386 114L386 150" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`;
}

function mug() {
  return `<g transform="translate(326 330)">
    <path d="M-8 0H88V86C88 112 68 128 42 128H38C12 128 -8 112 -8 86Z" fill="#FFF8EE" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>
    <path d="M88 30H104C132 30 144 44 144 66C144 88 132 102 104 102H88" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
    <path d="M22 18H58" stroke="#B98A64" stroke-width="8" stroke-linecap="round"/>
    <path d="M16 -20C0 -40 18 -52 8 -70M48 -20C32 -40 50 -52 40 -70" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round" opacity=".4"/>
  </g>`;
}

const stickers = [
  {
    id: 'joyeux',
    name: 'Joyeux',
    category: 'expressions',
    tags: ['joie', 'bonheur', 'sourire', 'content', 'happy'],
    palette: 'soleil',
    eye: 'happy',
    mouth: 'grin',
    extra: `${sparkle(98, 146, 22)}${sparkle(414, 118, 17, '#FFD7E4')}${sparkle(402, 360, 14, '#FFF3B0')}`,
  },
  {
    id: 'fou-rire',
    name: 'Fou rire',
    category: 'expressions',
    tags: ['rire', 'drôle', 'lol', 'mdr', 'hilarant'],
    palette: 'banane',
    eye: 'laugh',
    mouth: 'laugh',
    extra: `${teardrop(108, 212, 0.55)}${teardrop(404, 212, 0.55)}<path d="M140 170C126 160 115 160 104 168M372 170C386 160 397 160 408 168" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`,
  },
  {
    id: 'amour',
    name: 'Amour',
    category: 'expressions',
    tags: ['coeur', 'amour', 'aime', 'love'],
    palette: 'rose',
    eye: 'heart',
    mouth: 'small',
    extra: `${heart(96, 108, 0.55)}${heart(390, 118, 0.4, '#FF8FA3')}${heart(112, 360, 0.3, '#FF8FA3')}`,
  },
  {
    id: 'surprise',
    name: 'Surprise',
    category: 'expressions',
    tags: ['surprise', 'choc', 'wow', 'étonné', 'oh'],
    palette: 'ciel',
    eye: 'wide',
    mouth: 'o',
    extra: `<path d="M96 126V74M96 74L78 92M96 74L114 92" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M416 126V74M416 74L398 92M416 74L434 92" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    id: 'triste',
    name: 'Triste',
    category: 'expressions',
    tags: ['triste', 'pleure', 'peine', 'chagrin', 'sad'],
    palette: 'nuit',
    eye: 'sad',
    mouth: 'frown',
    extra: `${teardrop(298, 292, 0.65)}${teardrop(150, 334, 0.4)}`,
  },
  {
    id: 'en-colere',
    name: 'En colère',
    category: 'expressions',
    tags: ['colère', 'fâché', 'rage', 'grrr', 'angry'],
    palette: 'corail',
    eye: 'angry',
    mouth: 'grit',
    extra: steam(),
  },
  {
    id: 'timide',
    name: 'Timide',
    category: 'expressions',
    tags: ['timide', 'gêné', 'rouge', 'pudeur', 'shy'],
    palette: 'peche',
    eye: 'shy',
    mouth: 'small',
    extra: blush(),
  },
  {
    id: 'clin-doeil',
    name: 'Clin d’œil',
    category: 'expressions',
    tags: ['clin', 'oeil', 'complicité', 'wink', 'malin'],
    palette: 'lavande',
    eye: 'wink',
    mouth: 'smirk',
    extra: `${sparkle(402, 146, 20, '#FFF3B0')}${sparkle(118, 320, 12, '#D9C4FF')}`,
  },
  {
    id: 'fatigue',
    name: 'Fatigué',
    category: 'expressions',
    tags: ['fatigue', 'sommeil', 'crevé', 'dodo', 'tired'],
    palette: 'chocolat',
    eye: 'sleep',
    mouth: 'small',
    extra: `${teardrop(400, 152, 0.4, '#C8E9FF')}<path d="M170 205L208 215M344 205L306 215" stroke="${INK}" stroke-width="7" stroke-linecap="round" opacity=".5"/>`,
  },
  {
    id: 'bravo',
    name: 'Bravo',
    category: 'expressions',
    tags: ['bravo', 'félicitations', 'gagné', 'youpi', 'victoire'],
    palette: 'menthe',
    eye: 'happy',
    mouth: 'laugh',
    extra: `${arm(112, 302, -28, palettes.menthe)}${arm(400, 302, 28, palettes.menthe)}${confetti()}`,
  },
  {
    id: 'chat-calin',
    name: 'Chat câlin',
    category: 'animaux',
    tags: ['chat', 'minou', 'câlin', 'mignon', 'cat'],
    palette: 'peche',
    ear: 'cat',
    eye: 'heart',
    mouth: 'small',
    extra: `${heart(388, 330, 0.45)}<path d="M128 296L86 286M128 316L84 316M384 296L426 286M384 316L428 316" stroke="${INK}" stroke-width="6" stroke-linecap="round" opacity=".7"/>`,
  },
  {
    id: 'chien-content',
    name: 'Chien content',
    category: 'animaux',
    tags: ['chien', 'toutou', 'content', 'mignon', 'dog'],
    palette: 'chocolat',
    ear: 'dog',
    eye: 'happy',
    mouth: 'tongue',
    extra: `<ellipse cx="256" cy="302" rx="20" ry="14" fill="#3A2638"/>`,
  },
  {
    id: 'panda-dodo',
    name: 'Panda dodo',
    category: 'animaux',
    tags: ['panda', 'dormir', 'dodo', 'nuit', 'sleep'],
    palette: 'ciel',
    ear: 'panda',
    eye: 'none',
    mouth: 'small',
    extra: `${zzz()}${heart(390, 330, 0.3, '#B8C4FF')}<ellipse cx="205" cy="244" rx="43" ry="48" fill="#3A3042"/><ellipse cx="307" cy="244" rx="43" ry="48" fill="#3A3042"/>
      <path d="M178 248C191 234 218 234 232 248" fill="none" stroke="${WHITE}" stroke-width="9" stroke-linecap="round"/>
      <path d="M280 248C293 234 320 234 334 248" fill="none" stroke="${WHITE}" stroke-width="9" stroke-linecap="round"/>`,
  },
  {
    id: 'lapin-amour',
    name: 'Lapin amoureux',
    category: 'animaux',
    tags: ['lapin', 'amour', 'coeur', 'mignon', 'bunny'],
    palette: 'rose',
    ear: 'bunny',
    eye: 'heart',
    mouth: 'grin',
    extra: `${heart(402, 340, 0.4, '#FF8FA3')}${heart(112, 342, 0.3, '#FF8FA3')}`,
  },
  {
    id: 'grenouille-ok',
    name: 'Grenouille OK',
    category: 'animaux',
    tags: ['grenouille', 'ok', 'd’accord', 'oui', 'frog'],
    palette: 'menthe',
    ear: 'frog',
    eye: 'none',
    mouth: 'smile',
    extra: `<circle cx="160" cy="130" r="17" fill="${EYE}"/><circle cx="352" cy="130" r="17" fill="${EYE}"/><circle cx="154" cy="124" r="5" fill="${WHITE}"/><circle cx="346" cy="124" r="5" fill="${WHITE}"/>
      <path d="M206 238C216 226 232 226 242 238M302 238C312 226 328 226 338 238" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>`,
  },
  {
    id: 'perroquet-salut',
    name: 'Perroquet salut',
    category: 'animaux',
    tags: ['perroquet', 'salut', 'bonjour', 'coucou', 'mbolo'],
    palette: 'menthe',
    ear: 'parrot',
    eye: 'wink',
    mouth: 'grin',
    extra: `${arm(407, 304, 38, palettes.menthe)}<path d="M198 292C220 280 238 294 244 310C220 320 198 312 198 292Z" fill="#FFC93C" stroke="${INK}" stroke-width="8"/>
      <path d="M386 344C406 336 422 340 432 352" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`,
  },
  {
    id: 'merci',
    name: 'Merci',
    category: 'reactions',
    tags: ['merci', 'remercier', 'reconnaissance', 'thanks'],
    palette: 'rose',
    eye: 'happy',
    mouth: 'small',
    extra: `${heart(256, 318, 0.75)}${arm(164, 330, -52, palettes.rose)}${arm(348, 330, 52, palettes.rose)}`,
  },
  {
    id: 'courage',
    name: 'Courage',
    category: 'reactions',
    tags: ['courage', 'force', 'encouragement', 'bravo', 'fonce'],
    palette: 'corail',
    eye: 'determined',
    mouth: 'smirk',
    extra: `${arm(406, 276, 34, palettes.corail)}${sparkle(410, 196, 22, '#FFF3B0')}${sparkle(98, 330, 13, '#FFE27A')}`,
  },
  {
    id: 'bonne-nuit',
    name: 'Bonne nuit',
    category: 'reactions',
    tags: ['nuit', 'bonne nuit', 'dormir', 'rêve', 'bye'],
    palette: 'nuit',
    eye: 'sleep',
    mouth: 'small',
    extra: `${moon()}${zzz()}`,
    hat: 'cap',
  },
  {
    id: 'cafe',
    name: 'Café',
    category: 'reactions',
    tags: ['café', 'pause', 'boire', 'réveil', 'coffee'],
    palette: 'soleil',
    eye: 'happy',
    mouth: 'small',
    extra: mug(),
  },
];

function render(sticker) {
  const colors = palettes[sticker.palette];
  let bg = `<defs>${gradient('body', colors)}${gradient('ear', colors)}</defs>
    <ellipse cx="256" cy="464" rx="156" ry="22" fill="#201A2B" opacity=".12"/>`;
  bg += ears(sticker.ear, colors);
  if (sticker.hat) bg += cap();
  bg += body('body', colors);
  bg += feet();
  bg += highlight();
  bg += arm(100, 340, -20, colors);
  bg += arm(412, 340, 20, colors);
  if (sticker.eye !== 'none') bg += eyes(sticker.eye);
  bg += mouth(sticker.mouth);
  bg += sticker.extra ?? '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    ${bg}
  </svg>`;
}

mkdirSync(svgDir, { recursive: true });
for (const sticker of stickers) {
  const svg = render(sticker);
  const svgPath = join(svgDir, `${sticker.id}.svg`);
  writeFileSync(svgPath, svg);
  execFileSync('rsvg-convert', ['-w', '512', '-h', '512', '-o', join(outDir, `${sticker.id}.png`), svgPath], {
    stdio: 'inherit',
  });
}
rmSync(svgDir, { recursive: true, force: true });

const manifest = stickers.map(({ id, name, category, tags }) => ({ id, name, category, tags }));
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${stickers.length} stickers générés dans ${outDir}`);
