import { Redirect, Stack, useRouter } from 'expo-router';
import { Ban, CircleUserRound, Clock, EyeOff, Lock, MessageSquare, Phone } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceSheet, type ChoiceOption } from '@/components/choice-sheet';
import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useUserSettings } from '@/features/settings/useUserSettings';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
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

/** Confidentialité : visibilité du profil, contacts et présence. */
export default function PrivacySettingsScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { settings, error, update } = useUserSettings();
  const [choice, setChoice] = useState<ChoiceState | null>(null);

  if (!token) {
    return <Redirect href="/login" />;
  }

  const apply = (patch: Parameters<typeof update>[0]) => {
    void update(patch).catch((cause) => {
      Alert.alert(
        fr.settings.saveErrorTitle,
        cause instanceof ApiError ? cause.message : fr.settings.serverError,
      );
    });
  };

  const privacyChoice = (
    field: keyof UserSettings['privacy'],
    title: string,
    subtitle: string,
  ) => {
    setChoice({
      title,
      subtitle,
      value: settings.privacy[field],
      options: visibilityOptions(),
      onSelect: (value) => apply({ privacy: { [field]: value as Visibility } }),
    });
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.privacyTitle }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        {error ? (
          <ThemedText type="small" themeColor="textSecondary">
            {error}
          </ThemedText>
        ) : null}

        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={Clock}
            label={fr.settings.presence}
            onPress={() => router.push('/settings/presence')}
          />
          <SettingRow
            icon={EyeOff}
            label={fr.settings.hiddenChats}
            onPress={() => router.push('/settings/hidden')}
          />
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
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: Spacing.three,
  },
  group: { borderRadius: Radii.md, overflow: 'hidden' },
  lastRow: { borderBottomWidth: 0 },
});
