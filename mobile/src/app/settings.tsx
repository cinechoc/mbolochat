import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import {
  Ban,
  Bell,
  CircleUserRound,
  HelpCircle,
  Info,
  LogOut,
  Lock,
  MessageSquare,
  Moon,
  Phone,
  Shield,
  Smartphone,
  Trash2,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/bottom-sheet';
import { ChoiceSheet, type ChoiceOption } from '@/components/choice-sheet';
import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useUserSettings } from '@/features/settings/useUserSettings';
import { cacheSizeBytes, clearAppCache, formatBytes } from '@/features/settings/storage';
import { fr } from '@/i18n/fr';
import { useAppPreference } from '@/lib/app-preferences';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useTextScale, type TextSize } from '@/lib/text-scale';
import { useThemePreference, type ThemePreference } from '@/lib/theme-preference';
import type { UserSettings, Visibility } from '@/lib/types';

type ChoiceState = {
  title: string;
  subtitle?: string;
  value: string;
  options: ChoiceOption<string>[];
  onSelect: (value: string) => void;
};

const VISIBILITY_LABELS: Record<Visibility, string> = {
  everyone: fr.common.everyone,
  contacts: fr.common.contacts,
  nobody: fr.common.nobody,
};

function visibilityOptions(): ChoiceOption<string>[] {
  return (['everyone', 'contacts', 'nobody'] as Visibility[]).map((value) => ({
    value,
    label: VISIBILITY_LABELS[value],
  }));
}

function formatMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:00`;
}

function hourOptions(): ChoiceOption<string>[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour * 60),
    label: `${String(hour).padStart(2, '0')}:00`,
  }));
}

export default function SettingsScreen() {
  const { token, user, signOut } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { settings, error, update } = useUserSettings();
  const { preference, setPreference } = useThemePreference();
  const { size: textSize, setSize } = useTextScale();
  const [ringtone, setRingtone] = useAppPreference('ringtone');
  const [dataSaver, setDataSaver] = useAppPreference('callDataSaver');
  const [choice, setChoice] = useState<ChoiceState | null>(null);
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void cacheSizeBytes().then(setCacheBytes);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (token) {
        void api
          .listSessions(token)
          .then((sessions) => setDeviceCount(sessions.length))
          .catch(() => setDeviceCount(null));
      }
    }, [token]),
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const apply = (patch: Parameters<typeof update>[0]) => {
    const payload = { ...patch };
    // Les heures calmes sont exprimées dans le fuseau de l'appareil.
    if (payload.quietHours) {
      payload.quietHours = {
        ...payload.quietHours,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      };
    }
    void update(payload).catch((cause) => {
      Alert.alert(
        'Réglage non enregistré',
        cause instanceof ApiError ? cause.message : fr.settings.serverError,
      );
    });
  };

  const privacyChoice = (field: keyof UserSettings['privacy'], title: string, subtitle: string) => {
    setChoice({
      title,
      subtitle,
      value: settings.privacy[field],
      options: visibilityOptions(),
      onSelect: (value) => apply({ privacy: { [field]: value as Visibility } }),
    });
  };

  const quietChoice = (field: 'startMinute' | 'endMinute', title: string) => {
    setChoice({
      title,
      subtitle: 'Les appels restent sonores pendant les heures calmes.',
      value: String(settings.quietHours[field]),
      options: hourOptions(),
      onSelect: (value) => apply({ quietHours: { [field]: Number(value) } }),
    });
  };

  const requestDeletion = () => {
    Alert.alert(fr.settings.deleteAccount, fr.settings.deleteBody, [
      { text: fr.common.cancel, style: 'cancel' },
      { text: 'Continuer', style: 'destructive', onPress: () => setDeleteOpen(true) },
    ]);
  };

  const confirmDeletion = async () => {
    if (!token || deleting) return;
    setDeleting(true);
    try {
      await api.deleteAccount(token, deletePassword);
      setDeleteOpen(false);
      setDeletePassword('');
      Alert.alert(
        'Suppression programmée',
        'Votre compte sera anonymisé dans 30 jours. Reconnectez-vous avant cette date pour annuler.',
        [{ text: 'Fermer', onPress: () => void signOut() }],
      );
    } catch (cause) {
      Alert.alert(
        'Suppression impossible',
        cause instanceof ApiError ? cause.message : 'Réessayez plus tard.',
      );
    } finally {
      setDeleting(false);
    }
  };

  const section = (title: string) => (
    <ThemedText type="smallBold" themeColor="textSecondary" style={styles.section}>
      {title}
    </ThemedText>
  );

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.title }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        {error ? (
          <ThemedText type="small" themeColor="textSecondary">
            {error}
          </ThemedText>
        ) : null}

        {section(fr.settings.account)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={CircleUserRound}
            label={fr.settings.myProfile}
            onPress={() => router.push('/profile')}
          />
          <SettingRow
            icon={Shield}
            label={fr.settings.security}
            onPress={() => router.push('/settings/security')}
          />
          <SettingRow
            icon={Smartphone}
            label={fr.settings.devices}
            value={deviceCount === null ? undefined : fr.settings.devicesValue(deviceCount)}
            onPress={() => router.push('/settings/devices')}
            style={styles.lastRow}
          />
        </View>

        {section(fr.settings.notifications)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.messages}
            toggle={{
              value: settings.notifications.messages,
              onChange: (value) => apply({ notifications: { messages: value } }),
            }}
          />
          <SettingRow
            icon={CircleUserRound}
            label={fr.settings.groups}
            toggle={{
              value: settings.notifications.groups,
              onChange: (value) => apply({ notifications: { groups: value } }),
            }}
          />
          <SettingRow
            icon={Bell}
            label={fr.settings.mentions}
            toggle={{
              value: settings.notifications.mentions,
              onChange: (value) => apply({ notifications: { mentions: value } }),
            }}
          />
          <SettingRow
            icon={Phone}
            label={fr.settings.callsCategory}
            toggle={{
              value: settings.notifications.calls,
              onChange: (value) => apply({ notifications: { calls: value } }),
            }}
          />
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.reactions}
            toggle={{
              value: settings.notifications.reactions,
              onChange: (value) => apply({ notifications: { reactions: value } }),
            }}
          />
          <SettingRow
            icon={Bell}
            label={fr.settings.preview}
            toggle={{
              value: settings.notifications.preview,
              onChange: (value) => apply({ notifications: { preview: value } }),
            }}
          />
          <SettingRow
            icon={Bell}
            label={fr.settings.sound}
            toggle={{
              value: settings.notifications.sound,
              onChange: (value) => apply({ notifications: { sound: value } }),
            }}
          />
          <SettingRow
            icon={Moon}
            label={fr.settings.quietHours}
            value={fr.settings.quietHoursValue(
              formatMinute(settings.quietHours.startMinute),
              formatMinute(settings.quietHours.endMinute),
            )}
            toggle={{
              value: settings.quietHours.enabled,
              onChange: (value) => apply({ quietHours: { enabled: value } }),
            }}
            style={styles.lastRow}
          />
        </View>
        <View style={[styles.group, { backgroundColor: theme.backgroundElement, marginTop: Spacing.two }]}>
          <SettingRow
            label="Début des heures calmes"
            value={formatMinute(settings.quietHours.startMinute)}
            onPress={() => quietChoice('startMinute', 'Début des heures calmes')}
          />
          <SettingRow
            label="Fin des heures calmes"
            value={formatMinute(settings.quietHours.endMinute)}
            onPress={() => quietChoice('endMinute', 'Fin des heures calmes')}
            style={styles.lastRow}
          />
        </View>

        {section(fr.settings.privacy)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={Lock}
            label={fr.settings.profileVisibility}
            value={VISIBILITY_LABELS[settings.privacy.profile]}
            onPress={() =>
              privacyChoice('profile', fr.settings.profileVisibility, fr.privacy.profile)
            }
          />
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.whoCanWrite}
            value={VISIBILITY_LABELS[settings.privacy.write]}
            onPress={() => privacyChoice('write', fr.settings.whoCanWrite, fr.privacy.write)}
          />
          <SettingRow
            icon={CircleUserRound}
            label={fr.settings.whoCanAddToGroup}
            value={VISIBILITY_LABELS[settings.privacy.groupAdd]}
            onPress={() =>
              privacyChoice('groupAdd', fr.settings.whoCanAddToGroup, fr.privacy.groupAdd)
            }
          />
          <SettingRow
            icon={Phone}
            label={fr.settings.whoCanCall}
            value={VISIBILITY_LABELS[settings.privacy.call]}
            onPress={() => privacyChoice('call', fr.settings.whoCanCall, fr.privacy.call)}
          />
          <SettingRow
            icon={CircleUserRound}
            label={fr.settings.discoverability}
            value={VISIBILITY_LABELS[settings.privacy.discoverability]}
            onPress={() =>
              privacyChoice(
                'discoverability',
                fr.settings.discoverability,
                fr.privacy.discoverability,
              )
            }
          />
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.readReceipts}
            toggle={{
              value: settings.readReceipts,
              onChange: (value) => apply({ readReceipts: value }),
            }}
          />
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.typing}
            toggle={{
              value: settings.typingIndicator,
              onChange: (value) => apply({ typingIndicator: value }),
            }}
          />
          <SettingRow
            icon={Ban}
            label={fr.settings.blocked}
            onPress={() => router.push('/settings/blocked')}
            style={styles.lastRow}
          />
        </View>

        {section(fr.settings.discussions)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={Moon}
            label={fr.settings.theme}
            value={
              preference === 'light'
                ? fr.settings.themeLight
                : preference === 'dark'
                  ? fr.settings.themeDark
                  : fr.settings.themeSystem
            }
            onPress={() =>
              setChoice({
                title: fr.settings.theme,
                value: preference,
                options: [
                  { value: 'system', label: fr.settings.themeSystem },
                  { value: 'light', label: fr.settings.themeLight },
                  { value: 'dark', label: fr.settings.themeDark },
                ],
                onSelect: (value) => setPreference(value as ThemePreference),
              })
            }
          />
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.textSize}
            value={
              textSize === 'small'
                ? fr.settings.textSmall
                : textSize === 'large'
                  ? fr.settings.textLarge
                  : fr.settings.textNormal
            }
            onPress={() =>
              setChoice({
                title: fr.settings.textSize,
                value: textSize,
                options: [
                  { value: 'small', label: fr.settings.textSmall },
                  { value: 'normal', label: fr.settings.textNormal },
                  { value: 'large', label: fr.settings.textLarge },
                ],
                onSelect: (value) => setSize(value as TextSize),
              })
            }
            style={styles.lastRow}
          />
        </View>

        {section(fr.settings.calls)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={Phone}
            label={fr.settings.ringtone}
            toggle={{ value: ringtone, onChange: setRingtone }}
          />
          <SettingRow
            icon={Phone}
            label={fr.settings.dataSaver}
            toggle={{ value: dataSaver, onChange: setDataSaver }}
            style={styles.lastRow}
          />
        </View>

        {section(fr.settings.storage)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={Info}
            label={fr.settings.storageUsed}
            value={cacheBytes === null ? undefined : formatBytes(cacheBytes)}
          />
          <SettingRow
            icon={Trash2}
            label={fr.settings.clearCache}
            value={cacheBytes === null ? undefined : formatBytes(cacheBytes)}
            onPress={() => {
              void clearAppCache().then(async () => {
                setCacheBytes(await cacheSizeBytes());
                Alert.alert(fr.settings.cacheCleared, 'Les fichiers temporaires ont été supprimés.');
              });
            }}
            style={styles.lastRow}
          />
        </View>

        {section(fr.settings.about)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={HelpCircle}
            label={fr.settings.help}
            onPress={() => router.push('/settings/help')}
          />
          <SettingRow
            icon={Info}
            label={fr.settings.version}
            value={Constants.expoConfig?.version ?? '1.0.0'}
            style={styles.lastRow}
          />
        </View>

        <View style={[styles.group, { backgroundColor: theme.backgroundElement, marginTop: Spacing.three }]}>
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

      {choice ? (
        <ChoiceSheet
          visible
          title={choice.title}
          subtitle={choice.subtitle}
          options={choice.options}
          value={choice.value}
          onSelect={(value) => {
            choice.onSelect(value);
            setChoice(null);
          }}
          onClose={() => setChoice(null)}
        />
      ) : null}

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
            placeholder="Mot de passe"
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
            label={deleting ? 'Suppression…' : fr.settings.deleteConfirm}
            destructive
            onPress={() => void confirmDeletion()}
            disabled={!deletePassword || deleting}
            style={[
              styles.deleteButton,
              { backgroundColor: theme.backgroundElement },
            ]}
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
    gap: Spacing.two,
  },
  section: { letterSpacing: 0.8, marginTop: Spacing.two, marginBottom: Spacing.one },
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
