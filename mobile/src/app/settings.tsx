import { Redirect, Stack, useRouter } from 'expo-router';
import {
  AtSign,
  Ban,
  Bell,
  CircleUserRound,
  HelpCircle,
  Info,
  Lock,
  LogOut,
  Pencil,
  type LucideIcon,
} from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing, Radii } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';

interface SettingRow {
  key: string;
  label: string;
  icon: LucideIcon;
  onPress?: () => void;
  value?: string;
  destructive?: boolean;
}

/** Page « Paramètres », sur le modèle d'Instagram (c'est là que vit la déconnexion). */
export default function SettingsScreen() {
  const { token, user, signOut } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const accountRows: SettingRow[] = [
    {
      key: 'username',
      label: 'Nom d’utilisateur',
      icon: AtSign,
      value: `@${user.username}`,
    },
    {
      key: 'edit-profile',
      label: 'Modifier le profil',
      icon: Pencil,
      onPress: () => router.push('/profile/edit'),
    },
    {
      key: 'my-profile',
      label: 'Mon profil',
      icon: CircleUserRound,
      onPress: () => router.push('/profile'),
    },
  ];

  const privacyRows: SettingRow[] = [
    {
      key: 'notifications',
      label: 'Notifications',
      icon: Bell,
      value: user.notificationsEnabled ? 'Activées' : 'Désactivées',
      onPress: () => router.push('/settings/notifications'),
    },
    {
      key: 'privacy',
      label: 'Confidentialité',
      icon: Lock,
      onPress: () => router.push('/settings/privacy'),
    },
    {
      key: 'blocked',
      label: 'Comptes bloqués',
      icon: Ban,
      onPress: () => router.push('/settings/blocked'),
    },
  ];

  const aboutRows: SettingRow[] = [
    {
      key: 'help',
      label: 'Aide',
      icon: HelpCircle,
      onPress: () => router.push('/settings/help'),
    },
    {
      key: 'version',
      label: 'Version de l’application',
      icon: Info,
      value: '1.0.0',
    },
  ];

  const renderRow = (row: SettingRow) => (
    <Pressable
      key={row.key}
      onPress={row.onPress}
      disabled={!row.onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.backgroundElement },
        pressed && row.onPress ? { backgroundColor: theme.backgroundSelected } : null,
      ]}>
      <Icon
        icon={row.icon}
        size={22}
        color={row.destructive ? '#e5484d' : theme.text}
      />
      <ThemedText style={[styles.rowLabel, row.destructive ? styles.destructive : null]}>
        {row.label}
      </ThemedText>
      {row.value ? (
        <ThemedText type="small" themeColor="textSecondary">
          {row.value}
        </ThemedText>
      ) : null}
    </Pressable>
  );

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Paramètres' }} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + Spacing.four },
        ]}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          COMPTE
        </ThemedText>
        <ThemedView style={styles.group}>{accountRows.map(renderRow)}</ThemedView>

        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          CONFIDENTIALITÉ
        </ThemedText>
        <ThemedView style={styles.group}>{privacyRows.map(renderRow)}</ThemedView>

        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          À PROPOS
        </ThemedText>
        <ThemedView style={styles.group}>{aboutRows.map(renderRow)}</ThemedView>

        <View style={styles.group}>
          {renderRow({
            key: 'logout',
            label: 'Se déconnecter',
            icon: LogOut,
            destructive: true,
            onPress: () => void signOut(),
          })}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.two,
  },
  sectionTitle: {
    letterSpacing: 0.8,
    marginTop: Spacing.two,
    marginBottom: Spacing.one,
  },
  group: {
    borderRadius: Radii.md,
    overflow: 'hidden',
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
  destructive: {
    color: '#e5484d',
  },
});
