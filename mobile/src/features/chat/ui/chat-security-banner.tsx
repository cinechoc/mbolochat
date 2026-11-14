import { Lock, Unlock } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import type { ChatMode } from '../transport/types';

/**
 * Mention de sécurité de l'état vide : elle ne prétend jamais au chiffrement
 * pour une conversation historique, et disparaît dès le premier message.
 */
export function ChatSecurityBanner({ mode }: { mode: ChatMode | 'blocked' }) {
  const theme = useTheme();
  const label =
    mode === 'e2ee'
      ? fr.chat.unified.securityEncrypted
      : mode === 'blocked'
        ? fr.chat.unified.securityBlocked
        : fr.chat.unified.securityPlaintext;
  const Icon = mode === 'e2ee' ? Lock : Unlock;
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}
      accessibilityRole="text"
      accessibilityLabel={label}>
      <Icon size={13} strokeWidth={2.4} color={theme.textSecondary} />
      <ThemedText type="micro" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.threeHalf,
    paddingVertical: Spacing.one,
    marginBottom: Spacing.two,
    borderRadius: Radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    opacity: 0.88,
  },
});
