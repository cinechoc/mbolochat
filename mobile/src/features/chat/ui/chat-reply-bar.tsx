import { X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { QuoteBlock } from '@/components/quote-block';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import type { MessageQuote } from '@/lib/types';

/**
 * Barre « répondre à… » partagée : même surface que le compositeur, même
 * aperçu de citation, même bouton de fermeture. Le contenu de la citation est
 * fourni par l'appelant — l'écran chiffré le reconstruit depuis sa base locale.
 */
export function ChatReplyBar({
  quote,
  onCancel,
  onPressQuote,
  accessory,
}: {
  quote: MessageQuote;
  onCancel: () => void;
  onPressQuote?: () => void;
  accessory?: ReactNode;
}) {
  const chat = useChatColors();
  const theme = useTheme();
  return (
    <View style={[styles.replyBar, { backgroundColor: chat.composer }]}>
      <View style={styles.replyBarBody}>
        <QuoteBlock quote={quote} mine={false} onPress={onPressQuote} />
      </View>
      {accessory}
      <Pressable
        onPress={onCancel}
        hitSlop={8}
        style={styles.replyClose}
        accessibilityRole="button"
        accessibilityLabel={fr.common.cancel}>
        <X size={20} color={theme.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  replyBarBody: { flex: 1 },
  replyClose: { padding: Spacing.one },
});
