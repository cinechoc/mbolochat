import type { ImageSourcePropType } from 'react-native';

/**
 * Un sticker est identifié par une RÉFÉRENCE « idPack/idSticker » (ex. "mbolo/merci").
 * Seule cette référence voyage dans le message : aucun fichier n'est envoyé.
 */
export type TextSticker = {
  id: string;
  kind: 'text';
  label: string;
  /** Emoji décoratif (caractère unicode), optionnel. */
  emoji?: string;
  bg: string;
  fg: string;
  /** Inclinaison en degrés pour un rendu « autocollant ». */
  tilt?: number;
};

export type ImageSticker = {
  id: string;
  kind: 'image';
  /** require('../../../assets/stickers/monpack/bravo.webp') */
  source: ImageSourcePropType;
  /** Description pour l'accessibilité. */
  alt: string;
};

export type Sticker = TextSticker | ImageSticker;

export type StickerPack = {
  id: string;
  name: string;
  /** Emoji affiché sur l'onglet du pack. */
  iconEmoji: string;
  stickers: Sticker[];
};

/**
 * Pack de départ 100 % maison : des stickers typographiques aux expressions courantes,
 * sans aucune illustration externe. Les packs illustrés (kind: 'image') s'ajoutent
 * à côté, dans STICKER_PACKS.
 */
const MBOLO_PACK: StickerPack = {
  id: 'mbolo',
  name: 'Mbolo',
  iconEmoji: '👋',
  stickers: [
    { id: 'mbolo', kind: 'text', label: 'Mbolo !', emoji: '👋', bg: '#07C160', fg: '#FFFFFF', tilt: -4 },
    { id: 'merci', kind: 'text', label: 'Merci', emoji: '🙏', bg: '#FFB020', fg: '#3B2A00', tilt: 3 },
    { id: 'bonne-nuit', kind: 'text', label: 'Bonne nuit', emoji: '🌙', bg: '#3B4CCA', fg: '#FFFFFF', tilt: -3 },
    { id: 'bravo', kind: 'text', label: 'Bravo', emoji: '👏', bg: '#FF5A5F', fg: '#FFFFFF', tilt: 4 },
    { id: 'pardon', kind: 'text', label: 'Pardon', emoji: '🙇', bg: '#8E6BFF', fg: '#FFFFFF', tilt: -2 },
    { id: 'daccord', kind: 'text', label: "D'accord", emoji: '👍', bg: '#00A6A6', fg: '#FFFFFF', tilt: 2 },
    { id: 'ca-va', kind: 'text', label: 'Ça va ?', emoji: '😊', bg: '#FF8A3D', fg: '#FFFFFF', tilt: -4 },
    { id: 'ca-va-aller', kind: 'text', label: 'Ça va aller', emoji: '💪', bg: '#2BB673', fg: '#FFFFFF', tilt: 3 },
    { id: 'je-tappelle', kind: 'text', label: "Je t'appelle", emoji: '📞', bg: '#1E88E5', fg: '#FFFFFF', tilt: -3 },
    { id: 'plus-tard', kind: 'text', label: 'Plus tard', emoji: '⏳', bg: '#6D6D78', fg: '#FFFFFF', tilt: 2 },
    { id: 'felicitations', kind: 'text', label: 'Félicitations', emoji: '🎉', bg: '#E91E63', fg: '#FFFFFF', tilt: -2 },
    { id: 'courage', kind: 'text', label: 'Courage', emoji: '✊', bg: '#F4B400', fg: '#3B2A00', tilt: 4 },
  ],
};

/** Ajoute ici les futurs packs (illustrés ou typographiques). */
export const STICKER_PACKS: StickerPack[] = [MBOLO_PACK];

const REF_PATTERN = /^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,60}$/;

export function stickerRef(packId: string, stickerId: string): string {
  return `${packId}/${stickerId}`;
}

/** Vrai si la chaîne a la forme d'une référence de sticker (la même règle doit être appliquée par le backend). */
export function isValidStickerRef(ref: string): boolean {
  return REF_PATTERN.test(ref);
}

const STICKER_INDEX = new Map<string, Sticker>(
  STICKER_PACKS.flatMap((pack) =>
    pack.stickers.map((sticker) => [stickerRef(pack.id, sticker.id), sticker] as const),
  ),
);

/** Retourne le sticker ou `undefined` (pack inconnu : l'appli est peut-être plus ancienne que l'expéditeur). */
export function findSticker(ref: string): Sticker | undefined {
  return STICKER_INDEX.get(ref);
}
