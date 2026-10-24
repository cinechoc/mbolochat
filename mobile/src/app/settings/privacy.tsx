import { Redirect, Stack, useRouter } from 'expo-router';
import { Ban, ChevronRight, Clock, EyeOff, type LucideIcon } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';

interface PrivacyRow {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  onPress: () => void;
}

/** Confidentialité : comptes bloqués et conversations masquées. */
export default function PrivacySettingsScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  if (!token) {
    return <Redirect href="/login" />;
  }

  const rows: PrivacyRow[] = [
    {
      key: 'presence',
      label: 'Dernière connexion et en ligne',
      hint: 'Qui peut voir ta dernière connexion et ton statut en ligne',
      icon: Clock,
      onPress: () => router.push('/settings/presence'),
    },
    {
      key: 'blocked',
      label: 'Comptes bloqués',
      hint: 'Personnes qui ne peuvent plus t’envoyer de messages',
      icon: Ban,
      onPress: () => router.push('/settings/blocked'),
    },
    {
      key: 'hidden',
      label: 'Conversations masquées',
      hint: 'Discussions retirées de ta liste principale',
      icon: EyeOff,
      onPress: () => router.push('/settings/hidden'),
    },
  ];

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Confidentialité' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.four }}>
        <ThemedView style={styles.group}>
          {rows.map((row, index) => (
            <Pressable
              key={row.key}
              onPress={row.onPress}
              style={({ pressed }) => [
                styles.row,
                {
                  borderBottomColor: theme.backgroundElement,
                  borderBottomWidth: index === rows.length - 1 ? 0 : undefined,
                },
                pressed ? { backgroundColor: theme.backgroundSelected } : null,
              ]}>
              <Icon icon={row.icon} size={22} color={theme.text} />
              <ThemedText style={styles.rowLabel}>{row.label}</ThemedText>
              <ChevronRight size={22} color={theme.textSecondary} />
            </Pressable>
          ))}
        </ThemedView>
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          {rows.map((row) => row.hint).join(' · ')}
        </ThemedText>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  group: {
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: Spacing.three,
    marginTop: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
  },
  hint: {
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.two,
    lineHeight: 19,
  },
});
