import { Redirect, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { User } from '@/lib/types';

/** Comptes bloqués : on peut les débloquer à tout moment. */
export default function BlockedUsersScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [blocked, setBlocked] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const list = await api.listBlockedUsers(token);
      setBlocked(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger la liste.');
    } finally {
      setLoading(false);
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

  const unblock = async (id: string) => {
    try {
      await api.unblockUser(token, id);
      setBlocked((previous) => previous.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Débloquage impossible.');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Comptes bloqués' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.four }}>
        {blocked.length === 0 && !loading ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
            Tu n’as bloqué aucun compte. Les comptes bloqués ne peuvent plus t’envoyer de messages.
          </ThemedText>
        ) : (
          <ThemedView style={styles.group}>
            {blocked.map((item, index) => (
              <Pressable
                key={item.id}
                onPress={() => void unblock(item.id)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    borderBottomColor: theme.backgroundElement,
                    borderBottomWidth: index === blocked.length - 1 ? 0 : undefined,
                  },
                  pressed ? { backgroundColor: theme.backgroundSelected } : null,
                ]}>
                <Avatar name={item.displayName} uri={item.avatarUrl} size={40} />
                <View style={styles.rowBody}>
                  <ThemedText style={styles.rowName}>{item.displayName}</ThemedText>
                </View>
                <ThemedText style={styles.unblock}>Débloquer</ThemedText>
              </Pressable>
            ))}
          </ThemedView>
        )}

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  group: {
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    paddingHorizontal: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: { fontWeight: '600' },
  unblock: { color: '#3c87f7', fontWeight: '600' },
  empty: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    lineHeight: 20,
  },
  error: {
    color: '#e5484d',
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.three,
  },
});
