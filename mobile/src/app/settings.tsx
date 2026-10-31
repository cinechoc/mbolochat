import { Redirect, Stack, useRouter } from 'expo-router';
import {
  Bell,
  CircleUserRound,
  HardDrive,
  HelpCircle,
  Lock,
  LogOut,
  MessageSquare,
  Phone,
  Trash2,
} from 'lucide-react-native';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/bottom-sheet';
import { SettingRow } from '@/components/setting-row';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function SettingsScreen() {
  const { token, user, signOut } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const requestDeletion = () => {
    Alert.alert(fr.settings.deleteTitle, fr.settings.deleteBody, [
      { text: fr.common.cancel, style: 'cancel' },
      { text: fr.settings.deleteContinue, style: 'destructive', onPress: () => setDeleteOpen(true) },
    ]);
  };

  const confirmDeletion = async () => {
    if (!token || deleting) return;
    setDeleting(true);
    try {
      await api.deleteAccount(token, deletePassword);
      setDeleteOpen(false);
      setDeletePassword('');
      Alert.alert(fr.settings.deleteScheduledTitle, fr.settings.deleteScheduledBody, [
        { text: fr.common.close, onPress: () => void signOut() },
      ]);
    } catch (cause) {
      Alert.alert(
        fr.settings.deleteFailedTitle,
        cause instanceof ApiError ? cause.message : fr.settings.deleteFailedBody,
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.title }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={CircleUserRound}
            label={fr.settings.accountTitle}
            value={`@${user.username}`}
            onPress={() => router.push('/settings/account')}
          />
          <SettingRow
            icon={Lock}
            label={fr.settings.privacyTitle}
            onPress={() => router.push('/settings/privacy')}
          />
          <SettingRow
            icon={Bell}
            label={fr.settings.notificationsTitle}
            onPress={() => router.push('/settings/notifications')}
          />
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.discussionsTitle}
            onPress={() => router.push('/settings/discussions')}
          />
          <SettingRow
            icon={Phone}
            label={fr.settings.callsTitle}
            onPress={() => router.push('/settings/calls')}
          />
          <SettingRow
            icon={HardDrive}
            label={fr.settings.storageTitle}
            onPress={() => router.push('/settings/storage')}
          />
          <SettingRow
            icon={HelpCircle}
            label={fr.settings.aboutTitle}
            value={Constants.expoConfig?.version ?? '1.0.0'}
            onPress={() => router.push('/settings/help')}
            style={styles.lastRow}
          />
        </View>

        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={LogOut}
            label={fr.settings.logout}
            destructive
            onPress={() => void signOut()}
          />
          <SettingRow
            icon={Trash2}
            label={fr.settings.deleteAccount}
            destructive
            onPress={requestDeletion}
            style={styles.lastRow}
          />
        </View>
      </ScrollView>

      <BottomSheet
        visible={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeletePassword('');
        }}
        title={fr.settings.deleteAccount}
        subtitle={fr.settings.deleteBody}>
        <View style={styles.deleteSheet}>
          <TextInput
            value={deletePassword}
            onChangeText={setDeletePassword}
            placeholder={fr.settings.deletePassword}
            placeholderTextColor={theme.textSecondary}
            secureTextEntry
            autoCapitalize="none"
            style={[
              styles.passwordInput,
              { color: theme.text, backgroundColor: theme.backgroundElement },
            ]}
          />
          <SettingRow
            icon={Trash2}
            label={deleting ? fr.settings.deleting : fr.settings.deleteConfirm}
            destructive
            onPress={() => void confirmDeletion()}
            disabled={!deletePassword || deleting}
            style={[styles.deleteButton, { backgroundColor: theme.backgroundElement }]}
          />
        </View>
      </BottomSheet>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  group: { borderRadius: Radii.md, overflow: 'hidden' },
  lastRow: { borderBottomWidth: 0 },
  deleteSheet: { gap: Spacing.two, paddingBottom: Spacing.three },
  passwordInput: {
    minHeight: 48,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
  },
  deleteButton: { borderRadius: Radii.md, borderBottomWidth: 0 },
});
