import { describe, expect, it } from 'vitest';

import {
  attachPanelCap,
  DEFAULT_PANEL_HEIGHT,
  keyboardPanelHeight,
  MIN_ATTACH_PANEL_HEIGHT,
  MIN_EMOJI_PANEL_HEIGHT,
} from './panelSize';

/**
 * Hauteur d'une tuile du panneau « + » : pastille 58 px + libellé 2 lignes
 * (15 px) + gouttière, plus le titre et les marges du panneau. Trois tuiles
 * tiennent sur une ligne, huit sur trois lignes.
 */
const TILE_ROW = 92;
const PANEL_CHROME = 74;

function attachContentHeight(tiles: number): number {
  return PANEL_CHROME + Math.ceil(tiles / 4) * TILE_ROW;
}

describe('panneau « + » — hauteur dictée par le contenu', () => {
  it('trois tuiles : le panneau reste compact, très loin du plafond du clavier', () => {
    const cap = attachPanelCap(0, 0);
    expect(cap).toBeGreaterThanOrEqual(attachContentHeight(3));
    // C'est exactement le défaut corrigé : 3 tuiles ne doivent pas être
    // noyées dans une zone de la hauteur du clavier.
    expect(attachContentHeight(3)).toBeLessThan(cap * 0.75);
  });

  it('six puis huit tuiles : le contenu tient encore sous le plafond', () => {
    const cap = attachPanelCap(0, 0);
    expect(attachContentHeight(6)).toBeLessThanOrEqual(cap);
    expect(attachContentHeight(8)).toBeLessThanOrEqual(cap);
  });

  it('au-delà du plafond, le panneau ne grandit plus : il défile', () => {
    const cap = attachPanelCap(0, 0);
    const many = attachContentHeight(20);
    expect(many).toBeGreaterThan(cap);
    expect(cap).toBe(DEFAULT_PANEL_HEIGHT);
  });

  it('le plafond suit le clavier réel et la zone sûre du bas', () => {
    expect(attachPanelCap(0, 24)).toBe(DEFAULT_PANEL_HEIGHT + 24);
    expect(attachPanelCap(320, 24)).toBe(344);
    // Jamais sous le plancher des tuiles, même sans clavier connu.
    expect(attachPanelCap(0, 0)).toBeGreaterThanOrEqual(MIN_ATTACH_PANEL_HEIGHT);
  });

  it('le panneau d’emojis, lui, garde la hauteur du clavier', () => {
    expect(keyboardPanelHeight(0)).toBe(DEFAULT_PANEL_HEIGHT);
    expect(keyboardPanelHeight(320)).toBe(320);
    expect(keyboardPanelHeight(80)).toBe(MIN_EMOJI_PANEL_HEIGHT);
  });
});
