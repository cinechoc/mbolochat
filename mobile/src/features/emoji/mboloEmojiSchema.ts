/** Schéma du registre MboloChat (données générées, stables pour l'app et les tests). */

export type EmojiCoverage = 'illustrated' | 'unicode-fallback';

export type EmojiVariantKind =
  | 'base'
  | 'skin-tone'
  | 'zwj'
  | 'flag'
  | 'tag-flag'
  | 'keycap';

/** Sous-famille de visage ; seuls les `human` sont dans le périmètre de l'étape 1. */
export type EmojiFaceKind = 'human' | 'costume' | 'cat' | 'monkey';

export interface MboloEmojiEntry {
  /** Séquence Unicode exacte, conservée telle quelle dans les messages. */
  char: string;
  /** Clé stable : points de code hexadécimaux sans FE0F. */
  key: string;
  name: string;
  group: string;
  keywords: string[];
  /** Illustration panthère associée, ou null. */
  artId: string | null;
  coverage: EmojiCoverage;
  variantKind: EmojiVariantKind;
  /** Clé de la séquence de base pour une variante de peau. */
  variantOf: string | null;
  codePoints: number;
  /** Plusieurs séquences partagent cette illustration (documenté). */
  sharedArt: boolean;
  /** Visage humain, costume, chat ou singe ; null si ce n'est pas un visage. */
  faceKind: EmojiFaceKind | null;
  /** Nom Unicode du sous-groupe (face-smiling, cat-face…). */
  faceSubgroup: string | null;
}

export interface MboloEmojiGroupMeta {
  id: string;
  label: string;
  iconKey: string;
  iconChar: string;
}

export interface MboloEmojiCategoryStats {
  id: string;
  label: string;
  total: number;
  illustrated: number;
  fallback: number;
}

export interface MboloEmojiFaceStats {
  totalBase: number;
  totalSequences: number;
  humanBase: number;
  humanSequences: number;
  humanIllustrated: number;
  humanFallback: number;
  costumeBase: number;
  costumeSequences: number;
  catBase: number;
  catSequences: number;
  monkeyBase: number;
  monkeySequences: number;
}

export interface MboloEmojiStats {
  unicodeVersion: string;
  source: {
    package: string;
    version: string;
    locale: string;
    cldr: string;
  };
  baseEntries: number;
  skinVariants: number;
  totalSequences: number;
  distinctKeys: number;
  illustrated: number;
  unicodeFallback: number;
  artAssets: number;
  mappedArtAssets: number;
  sharedArtAssets: number;
  sharedIllustrations: number;
  categories: MboloEmojiCategoryStats[];
  variantKinds: Record<EmojiVariantKind, number>;
  faces: MboloEmojiFaceStats;
}
