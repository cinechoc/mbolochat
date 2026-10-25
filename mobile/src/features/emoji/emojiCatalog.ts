import type { ImageSourcePropType } from 'react-native';
// Ces deux fichiers sont GÉNÉRÉS par scripts/build-emoji-pack.mjs (ne pas les éditer à la main).
import { EMOJI_GROUPS as GENERATED_GROUPS } from './emojiData.generated';
import { EMOJI_SOURCES as GENERATED_SOURCES } from './emojiAssets.generated';

export type EmojiItem = { char: string; key: string; name: string };
export type EmojiGroup = { id: string; label: string; iconKey: string; emojis: EmojiItem[] };

export const EMOJI_GROUPS: EmojiGroup[] = GENERATED_GROUPS as EmojiGroup[];
export const EMOJI_SOURCES: Record<string, ImageSourcePropType> = GENERATED_SOURCES as Record<
  string,
  ImageSourcePropType
>;

/** Accès rapide clé -> emoji (pour reconstruire les « récents »). */
export const EMOJI_BY_KEY: Map<string, EmojiItem> = new Map(
  EMOJI_GROUPS.flatMap((g) => g.emojis.map((e) => [e.key, e] as const)),
);
