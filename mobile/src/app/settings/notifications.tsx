import { Redirect, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { conversationTitle } from '@/lib/format';
import type { ConversationSummary } from '@/lib/types';

/** Réglages des notifications : interrupteur global + silence par discussion. */
export default function NotificationSettingsScreen() {
  const { token, user, setUser } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const list = await api.listConversations(token);
      setConversations(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger les discussions.');
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const toggleGlobal = async (value: boolean) => {
    try {
      const updated = await api.setNotificationsEnabled(token, value);
      setUser(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Changement impossible.');
    }
  };

  const toggleMute = async (conversation: ConversationSummary, value: boolean) => {
    try {
      const updated = await api.setConversationPreferences(token, conversation.id, {
        muted: !value,
      });
      setConversations((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Changement impossible.');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Notifications' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.four }}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          DANS L&apos;APPLICATION
        </ThemedText>
        <ThemedView style={styles.group}>
          <View style={[styles.row, { borderBottomColor: theme.backgroundElement }]}>
            <MaterialIcons name="notifications" size={22} color={theme.text} />
            <ThemedText style={styles.rowLabel}>Notifications</ThemedText>
            <Switch
              value={user.notificationsEnabled}
              onValueChange={(value) => void toggleGlobal(value)}
              trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
            />
          </View>
        </ThemedView>
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          Quand cette option est désactivée, MboloChat n&apos;affiche plus les pastilles de messages
          non lus.
        </ThemedText>

        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          PAR DISCUSSION
        </ThemedText>
        {conversations.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
            Aucune discussion pour le moment.
          </ThemedText>
        ) : (
          <ThemedView style={styles.group}>
            {conversations.map((conversation, index) => {
              const title = conversationTitle(conversation, user.id);
              return (
                <Pressable
                  key={conversation.id}
                  onPress={() => void toggleMute(conversation, !conversation.muted)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      borderBottomColor: theme.backgroundElement,
                      borderBottomWidth: index === conversations.length - 1 ? 0 : undefined,
                    },
                    pressed ? { backgroundColor: theme.backgroundSelected } : null,
                  ]}>
                  <Avatar name={title} size={36} />
                  <ThemedText style={styles.rowLabel} numberOfLines={1}>
                    {title}
                  </ThemedText>
                  <Switch
                    value={!conversation.muted}
                    onValueChange={(value) => void toggleMute(conversation, value)}
                    trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
                  />
                </Pressable>
              );
            })}
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
  sectionTitle: {
    letterSpacing: 0.8,
    marginTop: Spacing.three,
    marginBottom: Spacing.one,
    paddingHorizontal: Spacing.three,
  },
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
  rowLabel: {
    flex: 1,
    fontSize: 16,
  },
  hint: {
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.one,
  },
  error: {
    color: '#e5484d',
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.three,
  },
});
