import { Redirect, Stack } from 'expo-router';
import { Phone } from 'lucide-react-native';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingRow } from '@/components/setting-row';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { useAppPreference } from '@/lib/app-preferences';
import { useAuth } from '@/lib/auth-context';

/** Appels : sonnerie et économie de données. */
export default function CallsSettingsScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [ringtone, setRingtone] = useAppPreference('ringtone');
  const [dataSaver, setDataSaver] = useAppPreference('callDataSaver');

  if (!token) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.callsTitle }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
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
      </ScrollView>
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
