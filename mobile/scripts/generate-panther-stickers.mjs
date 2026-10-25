#!/usr/bin/env node
/**
 * Génère la collection « Panthère Mbolo » : 26 stickers PNG 512 × 512,
 * fond transparent, dessinés en SVG puis rasterisés avec sharp.
 *
 *   node scripts/generate-panther-stickers.mjs
 *
 * Le personnage est entièrement original. Aucune image externe n'est utilisée.
 * Relancer le script réécrit mobile/assets/stickers/mbolo-panther/ et son
 * manifeste, sans toucher au reste de l'application.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'stickers', 'mbolo-panther');

const INK = '#1B1424';
const FUR = '#383047';
const FUR_BODY = '#2F273E';
const FUR_DARK = '#241E2E';
const FUR_LIGHT = '#4A3E5B';
const FUR_RIM = '#6B5A80';
const BELLY = '#403650';
const MUZZLE = '#4D425B';
const FACE = '#FFF3E4';
const PINK = '#F4A3BE';
const PINK_DARK = '#D97D9F';
const GOLD = '#F2B33D';
const EYE_WHITE = '#FFF8ED';
const HEART = '#EF5B7E';
const GREEN = '#2FBF71';
const RED = '#E5484D';
const PARTY = '#D6A9F7';
const MUG = '#F3EADB';
const TEAR = '#8FD8F7';

const EYE_L = 200;
const EYE_R = 312;
const EYE_Y = 226;
const HEAD_ROTATION = -1.5;

/* -------------------------------- Formes ---------------------------------- */

function heart(x, y, scale = 1, color = HEART, stroke = INK) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M0 18C-34 -8 -60 24 -28 52L0 76L28 52C60 24 34 -8 0 18Z" fill="${color}" stroke="${stroke}" stroke-width="6" stroke-linejoin="round"/>
    <ellipse cx="-19" cy="20" rx="7" ry="10" fill="#FFFFFF" opacity=".55" transform="rotate(-30 -19 20)"/>
  </g>`;
}

function sparkle(x, y, size = 18, color = '#FFE9A3') {
  return `<path d="M${x} ${y - size}L${x + size * 0.3} ${y - size * 0.3}L${x + size} ${y}L${x + size * 0.3} ${y + size * 0.3}L${x} ${y + size}L${x - size * 0.3} ${y + size * 0.3}L${x - size} ${y}L${x - size * 0.3} ${y - size * 0.3}Z" fill="${color}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`;
}

function teardrop(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M0 0C-16 24 -24 38 -24 50C-24 65 -13 76 0 76C13 76 24 65 24 50C24 38 16 24 0 0Z" fill="${TEAR}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="-7" cy="47" rx="5" ry="9" fill="#FFFFFF" opacity=".65"/>
  </g>`;
}

function tearStream(x, y, length = 44) {
  return `<path d="M${x} ${y}C${x - 8} ${y + length * 0.4} ${x + 8} ${y + length * 0.7} ${x} ${y + length}" fill="none" stroke="${TEAR}" stroke-width="11" stroke-linecap="round" opacity=".95"/>
    <circle cx="${x}" cy="${y + length + 8}" r="9" fill="${TEAR}" stroke="${INK}" stroke-width="4"/>`;
}

function badge(x, y, kind, r = 27) {
  const fill = kind === 'check' ? GREEN : kind === 'cross' ? RED : GOLD;
  let symbol;
  if (kind === 'check') {
    symbol = `<path d="M${x - 10} ${y + 1}L${x - 3} ${y + 9}L${x + 12} ${y - 9}" fill="none" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (kind === 'cross') {
    symbol = `<path d="M${x - 9} ${y - 9}L${x + 9} ${y + 9}M${x + 9} ${y - 9}L${x - 9} ${y + 9}" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round"/>`;
  } else {
    symbol = `<path d="M${x} ${y - 13}V${y + 4}" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round"/><circle cx="${x}" cy="${y + 13}" r="4" fill="#FFFFFF"/>`;
  }
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="5"/>
    <circle cx="${x - r * 0.35}" cy="${y - r * 0.4}" r="${r * 0.16}" fill="#FFFFFF" opacity=".6"/>${symbol}`;
}

function questionMark(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M-12 -14C-12 -34 8 -42 22 -34C38 -25 34 -4 19 4C10 9 8 15 8 22" fill="none" stroke="${INK}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M-12 -14C-12 -34 8 -42 22 -34C38 -25 34 -4 19 4C10 9 8 15 8 22" fill="none" stroke="${FACE}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="8" cy="44" r="7" fill="${FACE}" stroke="${INK}" stroke-width="4"/>
  </g>`;
}

function zzz(x, y, scale = 1) {
  const z = (ox, oy, s) => `<path d="M0 0H${30 * s}V${8 * s}L${10 * s} ${36 * s}H${30 * s}V${44 * s}H0V${36 * s}L${20 * s} ${8 * s}H0Z" transform="translate(${ox} ${oy})" fill="#DCCEFF" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`;
  return `<g transform="translate(${x} ${y}) scale(${scale})">${z(0, 34, 0.8)}${z(30, 8, 1)}${z(68, -28, 1.25)}</g>`;
}

// Les lignes de mouvement restent lisibles sur les deux thèmes.
const MOTION_INK = '#FFE9D6';

function motionLines(x, y, direction = 1) {
  return `<g opacity=".85" stroke="${MOTION_INK}" stroke-width="6" stroke-linecap="round">
    <path d="M${x} ${y}l${22 * direction} -10"/>
    <path d="M${x + 4 * direction} ${y + 22}l${24 * direction} -4"/>
    <path d="M${x - 2 * direction} ${y - 22}l${18 * direction} -14"/>
  </g>`;
}

/* --------------------------------- Visage --------------------------------- */

function eyeOpen(cx, cy, scale = 1) {
  return `<g transform="translate(${cx} ${cy}) scale(${scale})">
    <ellipse cx="0" cy="0" rx="36" ry="41" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="0" cy="4" rx="26" ry="29" fill="${GOLD}"/>
    <ellipse cx="0" cy="6" rx="13" ry="16" fill="#15101E"/>
    <circle cx="-9" cy="-8" r="8" fill="#FFFFFF"/>
    <circle cx="10" cy="15" r="4.5" fill="#FFFFFF" opacity=".85"/>
  </g>`;
}

function eyePleading(cx, cy) {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="0" rx="39" ry="45" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="0" cy="6" rx="28" ry="32" fill="${GOLD}"/>
    <ellipse cx="0" cy="8" rx="15" ry="19" fill="#15101E"/>
    <circle cx="-11" cy="-9" r="10" fill="#FFFFFF"/>
    <circle cx="12" cy="18" r="6" fill="#FFFFFF" opacity=".9"/>
    <path d="M-28 28C-14 39 14 39 28 28" fill="none" stroke="#BFEFFF" stroke-width="5" stroke-linecap="round" opacity=".9"/>
  </g>`;
}

function eyeHeart(cx, cy) {
  return `<g transform="translate(${cx} ${cy}) scale(1.08)">
    <path d="M0 6C-30 -18 -52 12 -24 38L0 60L24 38C52 12 30 -18 0 6Z" fill="${HEART}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
    <circle cx="-14" cy="8" r="6" fill="#FFFFFF" opacity=".7"/>
  </g>`;
}

function eyeArc(cx, cy, up = true) {
  return up
    ? `<path d="M${cx - 29} ${cy + 8}C${cx - 14} ${cy - 22} ${cx + 14} ${cy - 22} ${cx + 29} ${cy + 8}" fill="none" stroke="${FACE}" stroke-width="9" stroke-linecap="round"/>`
    : `<path d="M${cx - 29} ${cy - 2}C${cx - 14} ${cy + 20} ${cx + 14} ${cy + 20} ${cx + 29} ${cy - 2}" fill="none" stroke="${FACE}" stroke-width="9" stroke-linecap="round"/>`;
}

function eyeHalf(cx, cy, drop = 0) {
  return `<g transform="translate(${cx} ${cy + drop})">
    <ellipse cx="0" cy="0" rx="35" ry="40" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="0" cy="8" rx="24" ry="26" fill="${GOLD}"/>
    <ellipse cx="0" cy="10" rx="11" ry="13" fill="#15101E"/>
    <circle cx="-8" cy="0" r="7" fill="#FFFFFF"/>
    <path d="M-37 -3Q0 -54 37 -3L37 -48L-37 -48Z" fill="#2A233B" stroke="${INK}" stroke-width="4"/>
    <path d="M-37 -3Q0 -54 37 -3" fill="none" stroke="${FACE}" stroke-width="4" stroke-linecap="round" opacity=".55"/>
  </g>`;
}

function eyeSleep(cx, cy) {
  return `<path d="M${cx - 29} ${cy - 2}C${cx - 15} ${cy + 19} ${cx + 15} ${cy + 19} ${cx + 29} ${cy - 2}" fill="none" stroke="${FACE}" stroke-width="9" stroke-linecap="round"/>
    <path d="M${cx - 32} ${cy + 8}l-8 5M${cx + 32} ${cy + 8}l8 5" stroke="${FACE}" stroke-width="5" stroke-linecap="round" opacity=".8"/>`;
}

function eyeCry(cx, cy) {
  return `<path d="M${cx - 30} ${cy + 4}C${cx - 14} ${cy - 18} ${cx + 14} ${cy - 18} ${cx + 30} ${cy + 4}" fill="none" stroke="${FACE}" stroke-width="9" stroke-linecap="round"/>`;
}

function eyeSpiral(cx, cy, flip = 1) {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="0" rx="38" ry="42" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <path d="M0 0C0 -6 7 -9 12 -4C20 5 15 21 2 22C-16 23 -28 6 -20 -10C-11 -28 15 -31 27 -13" fill="none" stroke="${flip > 0 ? INK : '#5B4780'}" stroke-width="6" stroke-linecap="round"/>
  </g>`;
}

function eyeWide(cx, cy, shock = false) {
  const r = shock ? 1.14 : 1;
  return `<g transform="translate(${cx} ${cy}) scale(${r})">
    <ellipse cx="0" cy="0" rx="38" ry="44" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="0" cy="5" rx="${shock ? 12 : 18}" ry="${shock ? 14 : 21}" fill="${GOLD}"/>
    <ellipse cx="0" cy="6" rx="${shock ? 6 : 9}" ry="${shock ? 7 : 12}" fill="#15101E"/>
    <circle cx="-10" cy="-8" r="7" fill="#FFFFFF"/>
  </g>`;
}

function eyeSad(cx, cy, side) {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="0" rx="35" ry="40" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="0" cy="8" rx="24" ry="27" fill="${GOLD}"/>
    <ellipse cx="0" cy="12" rx="12" ry="14" fill="#15101E"/>
    <circle cx="-8" cy="0" r="7" fill="#FFFFFF"/>
    <path d="M${-37 * side} -6C${-22 * side} -2 ${-6 * side} -2 ${4 * side} -6" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round" opacity=".65"/>
  </g>`;
}

function eyeAngry(cx, cy, side) {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="0" rx="35" ry="38" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="0" cy="5" rx="23" ry="25" fill="${GOLD}"/>
    <ellipse cx="0" cy="7" rx="11" ry="13" fill="#15101E"/>
    <circle cx="-8" cy="-4" r="7" fill="#FFFFFF"/>
    <path d="M${-36 * side} -50L${10 * side} -28" stroke="${FACE}" stroke-width="8" stroke-linecap="round"/>
  </g>`;
}

function eyeShy(cx, cy, side) {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="0" rx="34" ry="38" fill="${EYE_WHITE}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="${-7 * side}" cy="7" rx="23" ry="26" fill="${GOLD}"/>
    <ellipse cx="${-7 * side}" cy="9" rx="11" ry="13" fill="#15101E"/>
    <circle cx="${-16 * side}" cy="0" r="7" fill="#FFFFFF"/>
  </g>`;
}

function eyes(kind) {
  switch (kind) {
    case 'happy':
      return eyeArc(EYE_L, EYE_Y) + eyeArc(EYE_R, EYE_Y);
    case 'laugh':
      return eyeArc(EYE_L, EYE_Y, false) + eyeArc(EYE_R, EYE_Y, false);
    case 'heart':
      return eyeHeart(EYE_L, EYE_Y) + eyeHeart(EYE_R, EYE_Y);
    case 'wide':
      return eyeWide(EYE_L, EYE_Y) + eyeWide(EYE_R, EYE_Y);
    case 'shock':
      return eyeWide(EYE_L, EYE_Y, true) + eyeWide(EYE_R, EYE_Y, true);
    case 'sad':
      return eyeSad(EYE_L, EYE_Y, -1) + eyeSad(EYE_R, EYE_Y, 1);
    case 'cry':
      return eyeCry(EYE_L, EYE_Y) + eyeCry(EYE_R, EYE_Y);
    case 'angry':
      return eyeAngry(EYE_L, EYE_Y, -1) + eyeAngry(EYE_R, EYE_Y, 1);
    case 'shy':
      return eyeShy(EYE_L, EYE_Y, -1) + eyeShy(EYE_R, EYE_Y, 1);
    case 'pleading':
      return eyePleading(EYE_L, EYE_Y) + eyePleading(EYE_R, EYE_Y);
    case 'sleep':
      return eyeSleep(EYE_L, EYE_Y) + eyeSleep(EYE_R, EYE_Y);
    case 'half':
      return eyeHalf(EYE_L, EYE_Y, 6) + eyeHalf(EYE_R, EYE_Y, 2);
    case 'wink':
      return eyeOpen(EYE_L, EYE_Y) + eyeArc(EYE_R, EYE_Y);
    case 'spiral':
      return eyeSpiral(EYE_L, EYE_Y, 1) + eyeSpiral(EYE_R, EYE_Y, -1);
    default:
      return eyeOpen(EYE_L, EYE_Y) + eyeOpen(EYE_R, EYE_Y);
  }
}

function brows(kind) {
  switch (kind) {
    case 'worried':
      return `<path d="M166 196C182 180 204 178 220 186M346 196C330 180 308 178 292 186" fill="none" stroke="${FACE}" stroke-width="7" stroke-linecap="round"/>`;
    case 'angry':
      return `<path d="M164 180C184 188 202 196 222 200M348 180C328 188 310 196 290 200" fill="none" stroke="${FACE}" stroke-width="8" stroke-linecap="round"/>`;
    case 'surprised':
      return `<path d="M170 180C184 166 204 164 218 172M342 180C328 166 308 164 294 172" fill="none" stroke="${FACE}" stroke-width="6" stroke-linecap="round"/>`;
    default:
      return '';
  }
}

function noseMouth(mouth) {
  const nose = `<path d="M239 278C248 271 264 271 273 278C271 288 264 296 256 298C248 296 241 288 239 278Z" fill="${HEART}" stroke="${INK}" stroke-width="4"/>
    <ellipse cx="248" cy="279" rx="4" ry="3" fill="#FFFFFF" opacity=".65"/>`;
  let m = '';
  switch (mouth) {
    case 'smile':
      m = `<path d="M226 306C239 321 273 321 286 306" fill="none" stroke="${FACE}" stroke-width="7" stroke-linecap="round"/>`;
      break;
    case 'small':
      m = `<path d="M243 305C250 312 262 312 269 305" fill="none" stroke="${FACE}" stroke-width="6" stroke-linecap="round"/>`;
      break;
    case 'grin':
      m = `<path d="M216 301C230 344 282 344 296 301Z" fill="#7A2840" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
        <path d="M235 328C245 318 267 318 277 328C270 340 242 340 235 328Z" fill="#FF8FA3"/>`;
      break;
    case 'laugh':
      m = `<path d="M203 296C218 372 294 372 309 296Z" fill="#7A2840" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
        <path d="M232 348C243 330 269 330 280 348C271 366 241 366 232 348Z" fill="#FF8FA3"/>`;
      break;
    case 'frown':
      m = `<path d="M230 317C242 299 270 299 282 317" fill="none" stroke="${FACE}" stroke-width="7" stroke-linecap="round"/>`;
      break;
    case 'wail':
      m = `<ellipse cx="256" cy="322" rx="28" ry="35" fill="#6E2339" stroke="${INK}" stroke-width="5"/>
        <ellipse cx="256" cy="341" rx="14" ry="13" fill="#FF8FA3"/>`;
      break;
    case 'o':
      m = `<ellipse cx="256" cy="313" rx="18" ry="23" fill="#6E2339" stroke="${INK}" stroke-width="5"/>
        <ellipse cx="256" cy="325" rx="9" ry="8" fill="#FF8FA3"/>`;
      break;
    case 'pucker':
      m = `<path d="M238 303C246 290 266 290 274 303C266 318 246 318 238 303Z" fill="${HEART}" stroke="${INK}" stroke-width="4"/>
        <path d="M244 304C250 309 262 309 268 304" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" opacity=".7"/>`;
      break;
    case 'wavy':
      m = `<path d="M230 310C239 300 246 318 256 308C266 298 273 316 282 306" fill="none" stroke="${FACE}" stroke-width="6" stroke-linecap="round"/>`;
      break;
    case 'grit':
      m = `<path d="M220 300H292C288 334 224 334 220 300Z" fill="${FACE}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
        <path d="M220 300H292M256 301V330M236 302L232 329M276 302L280 329" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
      break;
    case 'smirk':
      m = `<path d="M226 308C248 328 282 322 292 300" fill="none" stroke="${FACE}" stroke-width="7" stroke-linecap="round"/>`;
      break;
    default:
      m = '';
  }
  return nose + m;
}

/* -------------------------------- Membres --------------------------------- */

function paw(cx, cy, r = 25, pad = true) {
  const beans = pad
    ? `<ellipse cx="${cx}" cy="${cy + 4}" rx="${r * 0.38}" ry="${r * 0.34}" fill="${PINK}" stroke="${INK}" stroke-width="3"/>
       <circle cx="${cx - r * 0.4}" cy="${cy - r * 0.36}" r="${r * 0.17}" fill="${PINK}" stroke="${INK}" stroke-width="2.5"/>
       <circle cx="${cx}" cy="${cy - r * 0.46}" r="${r * 0.17}" fill="${PINK}" stroke="${INK}" stroke-width="2.5"/>
       <circle cx="${cx + r * 0.4}" cy="${cy - r * 0.36}" r="${r * 0.17}" fill="${PINK}" stroke="${INK}" stroke-width="2.5"/>`
    : `<path d="M${cx - r * 0.45} ${cy - r * 0.1}l${r * 0.3} -${r * 0.15}M${cx} ${cy - r * 0.18}v-${r * 0.28}M${cx + r * 0.45} ${cy - r * 0.1}l-${r * 0.3} -${r * 0.15}" stroke="${FACE}" stroke-width="4" stroke-linecap="round" opacity=".45"/>`;
  return `<g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${FUR_BODY}" stroke="${INK}" stroke-width="5"/>
    <circle cx="${cx - r * 0.32}" cy="${cy - r * 0.4}" r="${r * 0.2}" fill="${FUR_LIGHT}" opacity=".55"/>
    ${beans}
  </g>`;
}

function arm(shoulderX, shoulderY, angle, length = 72, width = 44, pawR = 26, pad = true) {
  const rad = (angle * Math.PI) / 180;
  const pawX = shoulderX - Math.sin(rad) * length;
  const pawY = shoulderY + Math.cos(rad) * length;
  const dx = (pawX - shoulderX) / length;
  const dy = (pawY - shoulderY) / length;
  const side = shoulderX < 256 ? -1 : 1;
  const bend = 16 * side;
  const controlX = (shoulderX + pawX) / 2 - dy * bend;
  const controlY = (shoulderY + pawY) / 2 + dx * bend;
  const d = `M${shoulderX} ${shoulderY}Q${controlX.toFixed(1)} ${controlY.toFixed(1)} ${pawX.toFixed(1)} ${pawY.toFixed(1)}`;
  return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${width + 10}" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="${FUR}" stroke-width="${width}" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="${FUR_LIGHT}" stroke-width="4" stroke-linecap="round" opacity=".5" transform="translate(-4 -3)"/>
    ${paw(pawX, pawY, pawR, pad)}`;
}

const ARM_POSES = {
  down: () => arm(165, 340, 12) + arm(347, 340, -12),
  relaxed: () => arm(158, 346, 18, 66, 40, 24) + arm(354, 346, -18, 66, 40, 24),
  waveRight: () => arm(165, 344, 14, 70, 42, 25) + arm(350, 346, -130, 94, 42, 28),
  waveLeft: () => arm(162, 346, 130, 94, 42, 28) + arm(347, 344, -14, 70, 42, 25),
  bothUp: () => arm(166, 346, 150, 94, 42, 27) + arm(346, 346, -150, 94, 42, 27),
  together: () => arm(170, 340, -74, 70, 40, 24) + arm(342, 340, 74, 70, 40, 24),
  cheeks: () => arm(172, 340, 166, 66, 38, 23) + arm(340, 340, -166, 66, 38, 23),
  cross: () => arm(172, 340, -80, 116, 40, 24) + arm(340, 340, 80, 116, 40, 24),
  belly: () => arm(170, 348, -40, 70, 40, 24) + arm(342, 348, 40, 70, 40, 24),
  heart: () => arm(170, 340, -72, 72, 40, 24) + arm(342, 340, 72, 72, 40, 24),
  fist: () => arm(165, 344, 14, 70, 42, 25) + arm(350, 346, -145, 88, 42, 28),
  thumb: () => arm(165, 344, 14, 70, 42, 25) + arm(350, 346, -145, 88, 42, 28, false),
  rubEyes: () => arm(160, 352, -158, 84, 38, 23) + arm(352, 352, 158, 84, 38, 23),
  chin: () => arm(165, 344, 14, 70, 42, 25) + arm(350, 346, 92, 72, 38, 23),
  spread: () => arm(165, 342, 70, 80, 40, 24) + arm(347, 342, -70, 80, 40, 24),
  shrug: () => arm(168, 344, 82, 76, 38, 23) + arm(344, 344, -82, 76, 38, 23),
};

/* -------------------------------- Décor ----------------------------------- */

function tailPath(kind) {
  switch (kind) {
    case 'up':
      return 'M362 406C432 400 466 332 434 280';
    case 'droop':
      return 'M362 416C444 438 478 414 462 374';
    case 'wag':
      return 'M360 410C432 442 480 386 466 330';
    case 'wrap':
      return 'M356 418C424 452 474 420 438 390C406 364 378 392 396 414';
    default:
      return 'M362 408C446 430 482 372 452 318';
  }
}

function tail(kind) {
  const d = tailPath(kind);
  return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="38" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="${FUR}" stroke-width="30" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="${FUR_LIGHT}" stroke-width="5" stroke-linecap="round" opacity=".55" transform="translate(-4 -6)"/>`;
}

function bodyGroup() {
  return `<g>
    <ellipse cx="204" cy="452" rx="48" ry="25" fill="${FUR_DARK}" stroke="${INK}" stroke-width="5"/>
    <ellipse cx="308" cy="452" rx="48" ry="25" fill="${FUR_DARK}" stroke="${INK}" stroke-width="5"/>
    <path d="M186 451l11 5M199 447l9 6M295 447l9 -6M308 452l11 -5" stroke="${FACE}" stroke-width="4" stroke-linecap="round" opacity=".28"/>
    <ellipse cx="256" cy="378" rx="114" ry="96" fill="${FUR_BODY}" stroke="${INK}" stroke-width="5"/>
    <path d="M332 316C360 348 360 408 324 442C374 416 384 350 350 306Z" fill="${FUR_DARK}" opacity=".55"/>
    <ellipse cx="218" cy="330" rx="36" ry="20" fill="${FUR_LIGHT}" opacity=".42" transform="rotate(-20 218 330)"/>
    <ellipse cx="256" cy="396" rx="64" ry="49" fill="${BELLY}"/>
    <ellipse cx="236" cy="376" rx="30" ry="16" fill="${FUR_LIGHT}" opacity=".28" transform="rotate(-14 236 376)"/>
    <path d="M338 352C356 372 356 404 338 424" fill="none" stroke="${FUR_RIM}" stroke-width="5" stroke-linecap="round" opacity=".5"/>
  </g>`;
}

function headGroup(sticker) {
  const rotation = HEAD_ROTATION + (sticker.tilt ?? 0);
  const innerEars = `<path d="M156 148C139 126 141 96 156 88C171 80 194 98 212 117C193 138 174 150 156 148Z" fill="${PINK}" stroke="${INK}" stroke-width="4"/>
    <path d="M156 148C148 134 150 111 161 98C177 111 191 126 201 139C185 150 169 152 156 148Z" fill="${PINK_DARK}" opacity=".45"/>
    <path d="M356 148C373 126 371 96 356 88C341 80 318 98 300 117C319 138 338 150 356 148Z" fill="${PINK}" stroke="${INK}" stroke-width="4"/>
    <path d="M356 148C364 134 362 111 351 98C335 111 321 126 311 139C327 150 343 152 356 148Z" fill="${PINK_DARK}" opacity=".45"/>`;
  const blushFor = sticker.blush ?? 0.32;
  return `<g transform="rotate(${rotation} 256 322)">
    <path d="M138 166C108 136 112 86 142 72C166 60 198 88 224 112C200 146 168 166 138 166Z" fill="${FUR}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
    <path d="M374 166C404 136 400 86 370 72C346 60 314 88 288 112C312 146 344 166 374 166Z" fill="${FUR}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
    <ellipse cx="256" cy="226" rx="152" ry="142" fill="${FUR}" stroke="${INK}" stroke-width="5"/>
    ${innerEars}
    <path d="M140 196C150 136 206 96 272 94C210 116 172 158 166 220Z" fill="${FUR_LIGHT}" opacity=".45"/>
    <path d="M352 136C394 190 394 282 334 346C396 318 416 220 388 160Z" fill="${FUR_DARK}" opacity=".42"/>
    <path d="M370 148C398 192 400 264 370 316" fill="none" stroke="${FUR_RIM}" stroke-width="5" stroke-linecap="round" opacity=".45"/>
    <path d="M128 274C122 266 121 258 124 250M383 274C389 266 390 258 387 250" fill="none" stroke="${FUR_LIGHT}" stroke-width="4" stroke-linecap="round" opacity=".55"/>
    <ellipse cx="256" cy="296" rx="59" ry="39" fill="${MUZZLE}"/>
    <ellipse cx="234" cy="304" rx="3" ry="2.4" fill="${FACE}" opacity=".38"/>
    <ellipse cx="278" cy="304" rx="3" ry="2.4" fill="${FACE}" opacity=".38"/>
    <path d="M170 294l-22 -4M172 304l-22 5M342 294l22 -4M340 304l22 5" stroke="${FACE}" stroke-width="3.5" stroke-linecap="round" opacity=".28"/>
    ${eyes(sticker.eye)}
    ${brows(sticker.brows)}
    ${noseMouth(sticker.mouth)}
    <ellipse cx="146" cy="286" rx="${26 + blushFor * 12}" ry="12" fill="${PINK}" opacity="${blushFor}"/>
    <ellipse cx="366" cy="286" rx="${26 + blushFor * 12}" ry="12" fill="${PINK}" opacity="${blushFor}"/>
  </g>`;
}

/* ------------------------------- Stickers --------------------------------- */

function propFor(id) {
  switch (id) {
    case 'bonjour':
      return `${sparkle(96, 140, 22)}${sparkle(414, 118, 16, '#FFD7E4')}${sparkle(402, 356, 13)}${motionLines(448, 270, 1)}`;
    case 'salut':
      return `${sparkle(92, 152, 18, '#FFD7E4')}${sparkle(424, 124, 22)}${heart(408, 368, 0.34)}`;
    case 'merci':
      return `${heart(256, 318, 0.7)}${heart(110, 178, 0.3, '#FF9CB8')}${heart(398, 320, 0.24, '#FF9CB8')}`;
    case 'sil-te-plait':
      return `${sparkle(112, 232, 16, '#DCCEFF')}${sparkle(414, 226, 13, '#FFE9A3')}${heart(408, 350, 0.26)}`;
    case 'ok':
      return `${badge(414, 140, 'check')}${sparkle(110, 196, 15, '#DCCEFF')}`;
    case 'oui':
      return `${badge(414, 146, 'check')}${motionLines(118, 216, -1)}`;
    case 'non':
      return `${badge(414, 146, 'cross')}<path d="M112 200C124 186 138 190 142 202" fill="none" stroke="${FACE}" stroke-width="6" stroke-linecap="round" opacity=".55"/>`;
    case 'amour':
      return `${heart(102, 142, 0.42)}${heart(412, 124, 0.32, '#FF9CB8')}${heart(112, 354, 0.26, '#FF9CB8')}${heart(404, 352, 0.36)}${sparkle(398, 236, 12, '#FFD7E4')}`;
    case 'bisou':
      return `${heart(424, 250, 0.4)}${heart(454, 196, 0.2, '#FF9CB8')}<path d="M402 288C416 280 430 286 434 300" fill="none" stroke="${FACE}" stroke-width="5" stroke-linecap="round" opacity=".55"/>`;
    case 'calin':
      return `${heart(256, 356, 0.62)}${heart(108, 190, 0.3)}${heart(406, 168, 0.24, '#FF9CB8')}`;
    case 'joie':
      return `${sparkle(98, 150, 22)}${sparkle(414, 128, 18, '#FFD7E4')}${sparkle(408, 358, 14)}${heart(102, 350, 0.24)}`;
    case 'fou-rire':
      return `${teardrop(108, 226, 0.55)}${teardrop(404, 226, 0.55)}<path d="M126 176C112 166 100 168 92 178M386 176C400 166 412 168 420 178" fill="none" stroke="${FACE}" stroke-width="6" stroke-linecap="round" opacity=".8"/>`;
    case 'tristesse':
      return `${teardrop(316, 300, 0.55)}`;
    case 'pleurs':
      return `${tearStream(182, 276, 54)}${tearStream(330, 276, 54)}<ellipse cx="256" cy="468" rx="82" ry="14" fill="${TEAR}" opacity=".5"/>`;
    case 'colere':
      return `${badge(414, 142, 'bang')}<path d="M104 164C86 144 108 120 92 98M408 230C428 214 418 194 432 178" fill="none" stroke="${FACE}" stroke-width="6" stroke-linecap="round" opacity=".55"/>`;
    case 'surprise':
      return `${badge(414, 138, 'bang')}<path d="M104 154C94 136 98 120 112 110M400 218C412 208 420 192 418 178" fill="none" stroke="${FACE}" stroke-width="6" stroke-linecap="round" opacity=".6"/>`;
    case 'choc':
      return `${badge(414, 130, 'bang')}${sparkle(100, 142, 16, '#FFD7E4')}<path d="M96 232l-18 -4M108 254l-16 8M416 244l18 -6" stroke="${FACE}" stroke-width="5" stroke-linecap="round" opacity=".6"/>`;
    case 'timidite':
      return `${teardrop(414, 226, 0.34)}<path d="M388 166C400 156 412 158 420 168" fill="none" stroke="${FACE}" stroke-width="5" stroke-linecap="round" opacity=".5"/>${sparkle(104, 190, 12, '#FFD7E4')}`;
    case 'sommeil':
      return `${zzz(344, 110)}<path d="M116 200C130 190 144 194 150 206" fill="none" stroke="${FACE}" stroke-width="5" stroke-linecap="round" opacity=".35"/>`;
    case 'fatigue':
      return `${heart(112, 170, 0.24, '#FF9CB8')}<path d="M402 244C414 234 426 236 432 246" fill="none" stroke="${FACE}" stroke-width="5" stroke-linecap="round" opacity=".45"/>
        <g transform="translate(328 356)">
          <path d="M0 0H62V52C62 72 47 84 31 84C15 84 0 72 0 52Z" fill="${MUG}" stroke="${INK}" stroke-width="5"/>
          <path d="M62 16H74C90 16 98 27 98 42C98 57 90 68 74 68H62" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
          <path d="M18 -10C8 -24 22 -32 14 -46M44 -10C34 -24 48 -32 40 -46" fill="none" stroke="${FACE}" stroke-width="5" stroke-linecap="round" opacity=".55"/>
          <path d="M31 34C23 25 12 38 24 48L31 54L38 48C50 38 39 25 31 34Z" fill="${HEART}" stroke="${INK}" stroke-width="3"/>
        </g>`;
    case 'reflexion':
      return `<g>
        <circle cx="388" cy="152" r="10" fill="${FACE}" stroke="${INK}" stroke-width="4"/>
        <circle cx="414" cy="126" r="14" fill="${FACE}" stroke="${INK}" stroke-width="4"/>
        <ellipse cx="446" cy="84" rx="40" ry="29" fill="${FACE}" stroke="${INK}" stroke-width="4"/>
        ${questionMark(446, 80, 0.72)}
      </g>`;
    case 'confusion':
      return `${questionMark(396, 116, 0.9)}${questionMark(112, 176, 0.55)}${sparkle(420, 280, 13, '#DCCEFF')}`;
    case 'fete':
      return `<g transform="translate(0 18)">
        <path d="M180 124L256 22L332 124Z" fill="${PARTY}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
        <path d="M214 124L256 66L298 124Z" fill="#E8C8FF" opacity=".55"/>
        <circle cx="256" cy="18" r="14" fill="${GOLD}" stroke="${INK}" stroke-width="4"/>
        <circle cx="256" cy="84" r="7" fill="${FACE}" stroke="${INK}" stroke-width="3"/>
        <circle cx="234" cy="106" r="6" fill="${FACE}" stroke="${INK}" stroke-width="3"/>
      </g>
      ${sparkle(106, 150, 18, '#FFD7E4')}${sparkle(414, 150, 16)}${heart(102, 350, 0.22)}${heart(410, 356, 0.24)}`;
    case 'encouragement':
      return `${sparkle(402, 236, 20)}${sparkle(108, 260, 14, '#FFD7E4')}${sparkle(430, 330, 12)}`;
    case 'pouce-leve':
      return `${sparkle(446, 178, 16, '#FFE9A3')}${heart(110, 172, 0.22, '#FF9CB8')}`;
    case 'au-revoir':
      return `${motionLines(440, 268, 1)}${heart(420, 356, 0.26)}${sparkle(104, 188, 14, '#FFD7E4')}`;
    default:
      return '';
  }
}

const STICKERS = [
  { id: 'bonjour', name: 'Bonjour', tags: ['bonjour', 'salut', 'hello', 'coucou', 'mbolo'], eye: 'happy', mouth: 'smile', arms: 'waveRight' },
  { id: 'salut', name: 'Salut', tags: ['salut', 'coucou', 'hello', 'wave', 'main'], eye: 'wink', mouth: 'grin', arms: 'bothUp', tilt: -3 },
  { id: 'merci', name: 'Merci', tags: ['merci', 'remercier', 'thanks', 'reconnaissance'], eye: 'happy', mouth: 'smile', arms: 'together', tilt: 2 },
  { id: 'sil-te-plait', name: "S'il te plaît", tags: ['s il te plait', 'please', 'demande', 'faveur'], eye: 'pleading', mouth: 'small', arms: 'together', tilt: 3, blush: 0.44 },
  { id: 'ok', name: 'OK', tags: ['ok', 'd accord', 'oui', 'valide', 'parfait'], eye: 'wink', mouth: 'smirk', arms: 'fist', tilt: -2 },
  { id: 'oui', name: 'Oui', tags: ['oui', 'yes', 'accord', 'valide'], eye: 'happy', mouth: 'grin', arms: 'waveRight', tilt: 4 },
  { id: 'non', name: 'Non', tags: ['non', 'no', 'refus', 'pas d accord'], eye: 'angry', brows: 'angry', mouth: 'grit', arms: 'cross', blush: 0.4 },
  { id: 'amour', name: 'Amour', tags: ['amour', 'coeur', 'love', 'aime'], eye: 'heart', mouth: 'small', arms: 'heart', blush: 0.45 },
  { id: 'bisou', name: 'Bisou', tags: ['bisou', 'kiss', 'coeur', 'amour'], eye: 'wink', mouth: 'pucker', arms: 'cheeks', tilt: -4, blush: 0.5 },
  { id: 'calin', name: 'Gros câlin', tags: ['calin', 'hug', 'câlin', 'tendresse'], eye: 'happy', mouth: 'grin', arms: 'spread', blush: 0.4 },
  { id: 'joie', name: 'Joie', tags: ['joie', 'bonheur', 'content', 'happy', 'sourire'], eye: 'happy', mouth: 'laugh', arms: 'bothUp' },
  { id: 'fou-rire', name: 'Fou rire', tags: ['rire', 'fou rire', 'lol', 'mdr', 'hilarant'], eye: 'laugh', mouth: 'laugh', arms: 'belly', tilt: 3 },
  { id: 'tristesse', name: 'Tristesse', tags: ['triste', 'sad', 'chagrin', 'peine'], eye: 'sad', brows: 'worried', mouth: 'frown', arms: 'relaxed', tail: 'droop', tilt: 2 },
  { id: 'pleurs', name: 'Pleurs', tags: ['pleurs', 'pleure', 'cry', 'larmes', 'sad'], eye: 'cry', brows: 'worried', mouth: 'wail', arms: 'rubEyes', tail: 'droop', tilt: 1 },
  { id: 'colere', name: 'Colère', tags: ['colere', 'angry', 'fache', 'boude', 'grrr'], eye: 'angry', brows: 'angry', mouth: 'grit', arms: 'cross', blush: 0.5, tail: 'wag' },
  { id: 'surprise', name: 'Surprise', tags: ['surprise', 'wow', 'etonne', 'oh'], eye: 'wide', brows: 'surprised', mouth: 'o', arms: 'spread', tail: 'up' },
  { id: 'choc', name: 'Choc', tags: ['choc', 'shock', 'stupeur', 'incroyable'], eye: 'shock', brows: 'surprised', mouth: 'o', arms: 'cheeks', tail: 'up', tilt: -3 },
  { id: 'timidite', name: 'Timidité', tags: ['timide', 'shy', 'gene', 'rouge', 'pudeur'], eye: 'shy', mouth: 'small', arms: 'together', tilt: 5, blush: 0.65 },
  { id: 'sommeil', name: 'Sommeil', tags: ['sommeil', 'dodo', 'dormir', 'sleep', 'nuit'], eye: 'sleep', mouth: 'small', arms: 'relaxed', tail: 'wrap', tilt: 4 },
  { id: 'fatigue', name: 'Fatigue', tags: ['fatigue', 'tired', 'creve', 'cafe', 'reveil'], eye: 'half', mouth: 'small', arms: 'relaxed', tilt: 3, blush: 0.22 },
  { id: 'reflexion', name: 'Réflexion', tags: ['reflexion', 'pense', 'think', 'idee'], eye: 'open', mouth: 'smirk', arms: 'chin', tilt: -4 },
  { id: 'confusion', name: 'Confusion', tags: ['confusion', 'perdu', 'question', 'comprends pas'], eye: 'spiral', brows: 'worried', mouth: 'wavy', arms: 'shrug', tilt: 7 },
  { id: 'fete', name: 'Fête', tags: ['fete', 'party', 'anniversaire', 'celebration', 'youpi'], eye: 'laugh', mouth: 'laugh', arms: 'bothUp', tail: 'wag', tilt: -2 },
  { id: 'encouragement', name: 'Encouragement', tags: ['encouragement', 'courage', 'fonce', 'bravo', 'force'], eye: 'open', brows: 'angry', mouth: 'grin', arms: 'fist', tilt: 2 },
  { id: 'pouce-leve', name: 'Pouce levé', tags: ['pouce leve', 'thumb up', 'bravo', 'super', 'ok'], eye: 'wink', mouth: 'smirk', arms: 'thumb', tilt: -3 },
  { id: 'au-revoir', name: 'Au revoir', tags: ['au revoir', 'bye', 'salut', 'depart', 'a bientot'], eye: 'happy', mouth: 'smile', arms: 'waveLeft', tilt: 2 },
];

/* -------------------------------- Rendu ----------------------------------- */

function thumbPawOverride(sticker) {
  if (sticker.arms !== 'thumb') return '';
  // Le pouce est ajouté par-dessus la patte levée de la pose « fist ».
  return `<g transform="rotate(18 400 274)">
    <rect x="408" y="212" width="28" height="62" rx="14" fill="${FUR_BODY}" stroke="${INK}" stroke-width="5"/>
    <path d="M414 228C412 242 412 258 415 268" fill="none" stroke="${FUR_LIGHT}" stroke-width="4" stroke-linecap="round" opacity=".7"/>
    <ellipse cx="422" cy="210" rx="11" ry="13" fill="${PINK}" stroke="${INK}" stroke-width="3"/>
    <circle cx="418" cy="205" r="3" fill="${FUR_LIGHT}" opacity=".8"/>
  </g>`;
}

function render(sticker) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${tail(sticker.tail ?? 'curl')}
  ${bodyGroup()}
  ${headGroup(sticker)}
  ${ARM_POSES[sticker.arms ?? 'down']()}
  ${thumbPawOverride(sticker)}
  ${propFor(sticker.id)}
</svg>`;
}

mkdirSync(outDir, { recursive: true });
const svgDir = join(outDir, '.svg-src');
mkdirSync(svgDir, { recursive: true });
for (const sticker of STICKERS) {
  const svg = render(sticker);
  writeFileSync(join(svgDir, `${sticker.id}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 144 })
    .resize(512, 512, { fit: 'contain' })
    .png({ compressionLevel: 9, effort: 10, palette: true, quality: 95, colours: 192 })
    .toFile(join(outDir, `${sticker.id}.png`));
}
rmSync(svgDir, { recursive: true, force: true });

const entries = STICKERS.map(({ id, name, tags }) => ({
  id,
  name,
  tags,
  alt: `Panthère Mbolo : ${name}`,
}));
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(entries, null, 2)}\n`);

const featuresDir = join(root, 'src', 'features', 'stickers');
const ids = STICKERS.map((sticker) => `  | '${sticker.id}'`).join('\n');
writeFileSync(
  join(featuresDir, 'pantherCatalog.generated.ts'),
  `// FICHIER GÉNÉRÉ par scripts/generate-panther-stickers.mjs : ne pas modifier à la main.
export type PantherStickerId =
${ids};

export type PantherStickerMeta = {
  id: PantherStickerId;
  name: string;
  tags: string[];
  alt: string;
};

export const PANTHER_STICKERS: PantherStickerMeta[] = ${JSON.stringify(entries, null, 2)};
`,
);

const sources = STICKERS.map(
  (sticker) =>
    `  '${sticker.id}': require('../../../assets/stickers/mbolo-panther/${sticker.id}.png'),`,
).join('\n');
writeFileSync(
  join(featuresDir, 'pantherAssets.generated.ts'),
  `// FICHIER GÉNÉRÉ par scripts/generate-panther-stickers.mjs : ne pas modifier à la main.
import type { ImageSourcePropType } from 'react-native';

import type { PantherStickerId } from './pantherCatalog.generated';

export const PANTHER_SOURCES: Record<PantherStickerId, ImageSourcePropType> = {
${sources}
};
`,
);

console.log(`${STICKERS.length} stickers Panthère Mbolo générés dans ${outDir}`);
