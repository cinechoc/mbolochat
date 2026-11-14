import { Bomb, Eye } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import type { ChatMessageView } from '../transport/types';
import { MessageText } from '@/features/emoji/EmojiText';

export function ViewOnceModal({
  message,
  onClose,
}: {
  message: ChatMessageView | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal visible={message !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.backgroundElevated, borderColor: theme.border }]}>
          <View style={[styles.icon, { backgroundColor: theme.accentSoft }]}>
            <Eye size={24} strokeWidth={2.2} color={theme.accent} />
          </View>
          <ThemedText type="sectionTitle" style={{ color: theme.text, textAlign: 'center' }}>
            {fr.chat.viewOnce.title}
          </ThemedText>
          {message ? (
            <View style={styles.body}>
              <MessageText
                text={message.body}
                style={{ color: theme.text, fontSize: 16, lineHeight: 22 }}
              />
            </View>
          ) : null}
          <ThemedText type="micro" style={{ color: theme.textSecondary, textAlign: 'center' }}>
            {fr.chat.viewOnce.warning}
          </ThemedText>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={fr.chat.viewOnce.close}
            style={({ pressed }) => [
              styles.close,
              { backgroundColor: theme.accent, opacity: pressed ? 0.78 : 1 },
            ]}>
            <Bomb size={18} strokeWidth={2.2} color={theme.onAccent} />
            <ThemedText type="smallBold" style={{ color: theme.onAccent }}>
              {fr.chat.viewOnce.close}
            </ThemedText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  card: {
    width: '100%',
    maxWidth: 460,
    borderRadius: Radii.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.four,
    gap: Spacing.three,
    alignItems: 'center',
  },
  icon: { width: 52, height: 52, borderRadius: Radii.full, alignItems: 'center', justifyContent: 'center' },
  body: {
    alignSelf: 'stretch',
    maxHeight: 320,
    borderRadius: Radii.sm,
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: Spacing.three,
  },
  close: {
    alignSelf: 'stretch',
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Radii.button,
  },
});
