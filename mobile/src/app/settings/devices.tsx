import { Redirect, Stack, useFocusEffect } from 'expo-router';
import { LogOut, Smartphone } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { DeviceSession } from '@/lib/types';

function lastSeenLabel(session: DeviceSession): string {
  const date = new Date(session.lastUsedAt);
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Appareils connectés : liste les sessions et permet de les révoquer à distance. */
export default function DevicesScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setSessions(await api.listSessions(token));
    } catch {
      setSessions([]);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!token) {
    return <Redirect href="/login" />;
  }

  const revoke = (session: DeviceSession) => {
    Alert.alert(
      'Déconnecter cet appareil ?',
      session.deviceName ?? 'Cet appareil ne recevra plus de notifications.',
      [
        { text: fr.common.cancel, style: 'cancel' },
        {
          text: 'Déconnecter',
          style: 'destructive',
          onPress: () => {
            if (!token) return;
            void api
              .revokeSession(token, session.id)
              .then(load)
              .catch((cause) => {
                Alert.alert(
                  'Déconnexion impossible',
                  cause instanceof ApiError ? cause.message : 'Réessayez plus tard.',
                );
              });
          },
        },
      ],
    );
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.devices }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <ThemedText type="small" themeColor="textSecondary">
          Ces appareils peuvent encore ouvrir votre compte. Révoquez ceux que vous ne
          reconnaissez pas.
        </ThemedText>
        {sessions === null ? null : sessions.length === 0 ? (
          <View style={styles.empty}>
            <Smartphone size={26} color={theme.textSecondary} />
            <ThemedText type="small" themeColor="textSecondary">
              Aucun appareil connecté.
            </ThemedText>
          </View>
        ) : (
          sessions.map((session) => (
            <View
              key={session.id}
              style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
              <SettingRow
                icon={Smartphone}
                label={session.deviceName ?? 'Appareil'}
                value={lastSeenLabel(session)}
                style={styles.firstRow}
              />
              <Pressable
                onPress={() => revoke(session)}
                accessibilityRole="button"
                accessibilityLabel={`Déconnecter ${session.deviceName ?? 'cet appareil'}`}
                style={({ pressed }) => [
                  styles.revoke,
                  { opacity: pressed ? 0.7 : 1 },
                ]}>
                <LogOut size={18} color="#e5484d" />
                <ThemedText type="small" style={{ color: '#e5484d', fontWeight: '600' }}>
                  Déconnecter
                </ThemedText>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two },
  empty: { alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.four },
  card: { borderRadius: Radii.md, overflow: 'hidden' },
  firstRow: { borderBottomWidth: 0 },
  revoke: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
