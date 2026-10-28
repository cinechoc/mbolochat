import React, { memo, useMemo } from 'react';
import { Image, StyleProp, StyleSheet, Text, TextProps, TextStyle, ImageStyle } from 'react-native';
import { EMOJI_LARGE_SOURCES, EMOJI_SOURCES } from './emojiCatalog';
import { emojiOnlyCount, splitEmoji } from './emojiUtils';

/**
 * Décalage vertical (en fraction de la taille) de l'emoji dans une ligne de texte.
 * À AJUSTER visuellement sur téléphone (iOS et Android alignent un peu différemment).
 */
const INLINE_SHIFT = 0.14;

type EmojiImageProps = {
  emojiKey: string;
  size: number;
  /** Utilise la version grand format (192 px) si elle existe : pour les emoji affichés en grand. */
  large?: boolean;
  style?: StyleProp<ImageStyle>;
};

/** Une image d'emoji, ou rien si l'emoji n'est pas dans le pack. */
export const EmojiImage = memo(function EmojiImage({ emojiKey, size, large, style }: EmojiImageProps) {
  const source = (large ? EMOJI_LARGE_SOURCES[emojiKey] : undefined) ?? EMOJI_SOURCES[emojiKey];
  if (!source) return null;
  return (
    <Image
      source={source}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
      fadeDuration={0} // Android : pas de fondu qui fait clignoter les emoji
    />
  );
});

type EmojiTextProps = Omit<TextProps, 'children'> & {
  children: string;
  /** Taille de l'emoji par rapport à la police (1.25 = légèrement plus grand que le texte). */
  emojiScale?: number;
  /** Utilise les assets 192 px pour un emoji affiché seul / en grand. */
  large?: boolean;
};

/**
 * Affiche un texte en remplaçant les emoji reconnus par les illustrations MboloChat.
 * Un emoji sans illustration reste affiché avec la police du système (repli Unicode).
 */
export const EmojiText = memo(function EmojiText({
  children,
  style,
  emojiScale = 1.25,
  large = false,
  ...rest
}: EmojiTextProps) {
  const fontSize = (StyleSheet.flatten(style) as TextStyle | undefined)?.fontSize ?? 16;
  const size = Math.round(fontSize * emojiScale);
  const segments = useMemo(() => splitEmoji(children), [children]);

  return (
    <Text style={style} {...rest}>
      {segments.map((segment, i) => {
        if (segment.type === 'text') return segment.value;
        const source =
          (large ? EMOJI_LARGE_SOURCES[segment.key] : undefined) ?? EMOJI_SOURCES[segment.key];
        if (!source) return segment.value;
        return (
          <Image
            key={i}
            source={source}
            fadeDuration={0}
            style={{ width: size, height: size, transform: [{ translateY: size * INLINE_SHIFT }] }}
          />
        );
      })}
    </Text>
  );
});

type MessageTextProps = Omit<TextProps, 'children'> & { text: string };

/** Texte d'un message : 1 à 3 emoji seuls s'affichent en grand, comme sur WeChat/WhatsApp. */
export const MessageText = memo(function MessageText({ text, style, ...rest }: MessageTextProps) {
  const count = useMemo(() => emojiOnlyCount(text), [text]);
  const jumbo: TextStyle | undefined =
    count === 0 ? undefined : { fontSize: count === 1 ? 38 : count === 2 ? 32 : 28 };
  return (
    <EmojiText
      style={[style, jumbo]}
      emojiScale={count ? 1.1 : 1.25}
      large={count > 0}
      {...rest}>
      {text}
    </EmojiText>
  );
});
