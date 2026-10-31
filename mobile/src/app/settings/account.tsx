import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import { CircleUserRound, Shield, Smartphone } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingRow } from '@/components/setting-row';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/** Compte : profil, sécurité et appareils connectés. */
export default function AccountSettingsScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [deviceCount, setDeviceCount] = useState<number | null>(null);

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

  if (!token) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.accountTitle }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
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
