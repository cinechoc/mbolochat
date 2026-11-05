import { Redirect, Stack, useFocusEffect } from 'expo-router';
import { MapPin } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useUserSettings } from '@/features/settings/useUserSettings';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { useAuth } from '@/lib/auth-context';
import {
  captureCity,
  getLocationAccess,
  requestLocationAccess,
  type LocationAccess,
  type LocationAccessStatus,
} from '@/lib/location';

const STATUS_LABELS: Record<LocationAccessStatus, string> = {
  granted: fr.location.granted,
  undetermined: fr.location.undetermined,
  denied: fr.location.denied,
  unavailable: fr.location.unavailable,
};

/**
 * Localisation : activation de l'accès système et ville détectée. Une fois
 * l'accès accordé, la ville est mise à jour automatiquement, sans action ici.
 */
export default function LocationSettingsScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { settings, reload } = useUserSettings();
  const [access, setAccess] = useState<LocationAccess | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshAccess = useCallback(async () => {
    setAccess(await getLocationAccess());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshAccess();
    }, [refreshAccess]),
  );

  // Retour depuis les réglages Android : la permission a pu changer.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshAccess();
      }
    });
    return () => subscription.remove();
  }, [refreshAccess]);

  if (!token) {
    return <Redirect href="/login" />;
  }

  const updateCity = async () => {
    const status = await captureCity(token);
    if (status === 'updated' || status === 'unchanged') {
      await reload();
      return;
    }
    if (status === 'mocked') {
      Alert.alert(fr.location.errorTitle, fr.location.mocked);
      return;
    }
    if (status === 'unavailable') {
      Alert.alert(fr.location.errorTitle, fr.location.unavailableHint);
      return;
    }
    if (status === 'failed') {
      Alert.alert(fr.location.errorTitle, fr.location.failedHint);
    }
  };

  const activate = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const next = await requestLocationAccess();
      setAccess(next);
      if (next.status === 'granted') {
        await updateCity();
        return;
      }
      if (next.status === 'denied' && !next.canAskAgain) {
        Alert.alert(fr.location.errorTitle, fr.location.deniedHint, [
          { text: fr.common.cancel, style: 'cancel' },
          { text: fr.location.openSettings, onPress: () => void Linking.openSettings() },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  const onAutomaticPress = () => {
    if (!access || access.status === 'unavailable') {
      return;
    }
    if (access.status === 'granted') {
      void Linking.openSettings();
      return;
    }
    void activate();
  };

  const hint =
    access?.status === 'unavailable'
      ? fr.location.unavailableHint
      : access?.status === 'denied' && !access.canAskAgain
        ? fr.location.deniedHint
        : fr.location.privacy;

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.location.title }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={MapPin}
            label={fr.location.city}
            value={settings.city ?? fr.location.unknownCity}
          />
          <SettingRow
            icon={MapPin}
            label={fr.location.access}
            value={
              busy
                ? fr.location.activating
                : access
                  ? STATUS_LABELS[access.status]
                  : fr.location.loading
            }
            onPress={access && access.status !== 'unavailable' ? onAutomaticPress : undefined}
            style={styles.lastRow}
          />
        </View>

        <ThemedText type="small" themeColor="textSecondary">
          {hint}
        </ThemedText>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  group: { borderRadius: Radii.md, overflow: 'hidden' },
  lastRow: { borderBottomWidth: 0 },
});
