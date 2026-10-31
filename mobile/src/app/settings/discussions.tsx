import { Redirect, Stack } from 'expo-router';
import { MessageSquare, Moon } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceSheet, type ChoiceOption } from '@/components/choice-sheet';
import { SettingRow } from '@/components/setting-row';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { useAuth } from '@/lib/auth-context';
import { useTextScale, type TextSize } from '@/lib/text-scale';
import { useThemePreference, type ThemePreference } from '@/lib/theme-preference';

type ChoiceState = {
  title: string;
  value: string;
  options: ChoiceOption<string>[];
  onSelect: (value: string) => void;
};

/** Discussions : apparence des conversations. */
export default function DiscussionsSettingsScreen() {
  const { token } = useAuth();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { preference, setPreference } = useThemePreference();
  const { size: textSize, setSize } = useTextScale();
  const [choice, setChoice] = useState<ChoiceState | null>(null);

  if (!token) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.discussionsTitle }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
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
      </ScrollView>

      {choice ? (
        <ChoiceSheet
          visible
          title={choice.title}
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
