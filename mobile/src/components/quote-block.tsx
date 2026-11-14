import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';
import { EmojiText } from '@/features/emoji/EmojiText';
import type { MessageQuote } from '@/lib/types';

/** Aperçu d'un message cité : texte, ou libellé de la pièce jointe. */
export function quoteText(quote: MessageQuote): string {
  if (quote.deleted) {
    return 'Message supprimé';
  }
  if (quote.type === 'sticker') {
    return 'Sticker';
  }
  if (quote.content) {
    return quote.content;
  }
  switch (quote.attachmentType) {
    case 'AUDIO':
      return 'Message vocal';
    case 'VIDEO':
      return 'Vidéo';
    case 'IMAGE':
      return 'Photo';
    case 'GIF':
      return 'GIF';
    case 'STICKER':
      return 'Sticker';
    case 'FILE':
      return 'Document';
    default:
      return 'Pièce jointe';
  }
}

/** Bandeau du message cité, posé au-dessus du texte de la réponse. */
export function QuoteBlock({
  quote,
  mine,
  onPress,
}: {
  quote: MessageQuote;
  mine: boolean;
  onPress?: () => void;
}) {
  const chat = useChatColors();
  const tone = useMemo(
    () => ({
      quote: { backgroundColor: mine ? chat.quoteBackgroundMine : chat.quoteBackground },
      bar: { backgroundColor: mine ? chat.quoteBarMine : chat.quoteBar },
      name: { color: chat.quoteName },
      text: { color: chat.quoteText },
    }),
    [chat, mine],
  );
  const body = (
    <View style={[styles.quote, tone.quote]}>
      <View style={[styles.quoteBar, tone.bar]} />
      <View style={styles.quoteBody}>
        <ThemedText type="smallBold" numberOfLines={1} ellipsizeMode="tail" style={tone.name}>
          {quote.senderName}
        </ThemedText>
        <EmojiText
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.quotePreviewText, tone.text]}>
          {quoteText(quote)}
        </EmojiText>
      </View>
    </View>
  );
  if (!onPress) {
    return body;
  }
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel="Aller au message cité">
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /** Citation : barre colorée et aperçu sur une ligne, dans la bulle de la réponse. */
  quote: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    minWidth: 190,
    maxWidth: '100%',
    gap: Spacing.two,
    borderRadius: Radii.xs,
    paddingVertical: Spacing.one,
    paddingRight: Spacing.one,
    overflow: 'hidden',
  },
  quoteBar: {
    width: 4,
    minHeight: 34,
    borderRadius: Radii.full,
  },
  quotePreviewText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  quoteBody: {
    flex: 1,
    minWidth: 0,
    gap: 1,
    paddingRight: Spacing.one,
  },
});
