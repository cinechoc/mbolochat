import { memo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useChatColors } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';

/**
 * Enveloppe de bulle partagée par la conversation claire et la conversation
 * chiffrée : même rayon, même padding, même coin « pincé » côté expéditeur,
 * même petite queue. Le contenu (texte, média, citation, libellé) reste à la
 * charge de l'appelant, car les deux pipelines n'affichent pas les mêmes
 * artefacts (accusés de réception côté clair, rien côté chiffré).
 *
 * Mémoïsée : c'est l'enveloppe de chaque ligne de la liste ; sans mémo,
 * chaque message re-rend la bulle dès qu'un accusé ou une présence change.
 */
export const ChatBubble = memo(function ChatBubble({
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
});

export const chatBubbleStyles = StyleSheet.create({
  bubble: {
    borderRadius: Radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: Spacing.half,
  },
  /** Coin côté expéditeur plus fermé : géométrie WeChat, sans arrondi mou. */
  bubbleMineEdge: { borderTopRightRadius: Radii.xs },
  bubbleTheirsEdge: { borderTopLeftRadius: Radii.xs },
  tail: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 2,
    top: 11,
    transform: [{ rotate: '45deg' }],
  },
  tailLeft: { left: -3 },
  tailRight: { right: -3 },
});

const styles = chatBubbleStyles;
