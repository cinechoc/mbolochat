import React, { memo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { EmojiImage } from '../emoji/EmojiText';
import { toEmojiKey } from '../emoji/emojiUtils';
import { findSticker, type Sticker } from './stickerPacks';
import { Radii } from '@/constants/theme';

type StickerViewProps = { sticker: Sticker; size?: number };

/** Dessine un sticker dans un carré de `size` px. */
export const StickerView = memo(function StickerView({ sticker, size = 96 }: StickerViewProps) {
  if (sticker.kind === 'image') {
    return (
      <Image
        source={sticker.source}
        style={{ width: size, height: size }}
        resizeMode="contain"
        accessibilityLabel={sticker.alt}
      />
    );
  }

  const border = Math.max(3, Math.round(size * 0.04));
  return (
    <View
      accessible
      accessibilityLabel={`Sticker : ${sticker.label}`}
      style={[
        styles.card,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.24),
          borderWidth: border,
          backgroundColor: sticker.bg,
          transform: [{ rotate: `${sticker.tilt ?? 0}deg` }],
        },
      ]}
    >
      {sticker.emoji ? (
        <EmojiImage
          emojiKey={toEmojiKey(sticker.emoji)}
          size={Math.round(size * 0.36)}
          large={Math.round(size * 0.36) > 40}
        />
      ) : null}
      <Text
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        style={[styles.label, { color: sticker.fg, fontSize: Math.round(size * 0.2) }]}
      >
        {sticker.label}
      </Text>
    </View>
  );
});

type StickerMessageProps = { stickerRef: string; size?: number };

/**
 * Contenu d'un message sticker : SANS bulle, comme sur WeChat/WhatsApp.
 * Si le pack est inconnu (appli plus ancienne que l'expéditeur), affiche un repli lisible.
 */
export const StickerMessage = memo(function StickerMessage({ stickerRef, size = 140 }: StickerMessageProps) {
  const sticker = findSticker(stickerRef);
  if (!sticker) {
    return (
      <View style={[styles.unknown, { width: size, height: size * 0.5 }]}>
        <Text style={styles.unknownText}>
          Sticker non disponible. Mets l&apos;application à jour.
        </Text>
      </View>
    );
  }
  return <StickerView sticker={sticker} size={size} />;
});

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#FFFFFF', // contour blanc : effet « autocollant découpé »
    paddingHorizontal: 6,
    gap: 4,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  label: { fontWeight: '800', textAlign: 'center' },
  unknown: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
    borderRadius: Radii.sm,
    backgroundColor: 'rgba(128,128,128,0.2)',
  },
  unknownText: { fontSize: 12, textAlign: 'center', color: '#888' },
});
