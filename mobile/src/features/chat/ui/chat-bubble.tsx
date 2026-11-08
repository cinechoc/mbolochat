import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useChatColors } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';

/**
 * Enveloppe de bulle partagée par la conversation claire et la conversation
 * chiffrée : même rayon, même padding, même coin « pincé » côté expéditeur,
 * même petite queue. Le contenu (texte, média, citation, libellé) reste à la
 * charge de l'appelant, car les deux pipelines n'affichent pas les mêmes
 * artefacts (accusés de réception côté clair, rien côté chiffré).
 */
export function ChatBubble({
  mine,
  children,
  style,
}: {
  mine: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const chat = useChatColors();
  return (
    <View
      style={[
        styles.bubble,
        mine ? { backgroundColor: chat.mineBubble } : { backgroundColor: chat.theirBubble },
        mine ? styles.bubbleMineEdge : styles.bubbleTheirsEdge,
        style,
      ]}>
      <View
        pointerEvents="none"
        style={[
          styles.tail,
          mine ? styles.tailRight : styles.tailLeft,
          mine ? { backgroundColor: chat.mineBubble } : { backgroundColor: chat.theirBubble },
        ]}
      />
      {children}
    </View>
  );
}

export const chatBubbleStyles = StyleSheet.create({
  bubble: {
    borderRadius: Radii.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: Spacing.half,
  },
  /** Coin côté expéditeur légèrement plus petit : donne la direction de la bulle. */
  bubbleMineEdge: { borderTopRightRadius: Radii.xs },
  bubbleTheirsEdge: { borderTopLeftRadius: Radii.xs },
  tail: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: Radii.xs,
    top: 13,
    transform: [{ rotate: '45deg' }],
  },
  tailLeft: { left: -4 },
  tailRight: { right: -4 },
});

const styles = chatBubbleStyles;
