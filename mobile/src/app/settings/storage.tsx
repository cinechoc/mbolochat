import { Redirect, Stack } from 'expo-router';
import { Info, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingRow } from '@/components/setting-row';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { cacheSizeBytes, clearAppCache, formatBytes } from '@/features/settings/storage';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { useAuth } from '@/lib/auth-context';

/** Stockage : espace utilisé par le cache et nettoyage. */
export default function StorageSettingsScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);

  useEffect(() => {
    void cacheSizeBytes().then(setCacheBytes);
  }, []);

  if (!token) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.storageTitle }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
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
                Alert.alert(fr.settings.cacheCleared, fr.settings.cacheClearedBody);
              });
            }}
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
