import { Redirect, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { conversationTitle } from '@/lib/format';
import type { ConversationSummary } from '@/lib/types';

/** Conversations masquées : on peut les remettre dans la liste principale. */
export default function HiddenConversationsScreen() {
  const { token, user } = useAuth();
  const insets = useSafeAreaInsets();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const list = await api.listHiddenConversations(token);
      setConversations(list);
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

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const show = async (conversation: ConversationSummary) => {
    try {
      await api.setConversationPreferences(token, conversation.id, { hidden: false });
      setConversations((previous) => previous.filter((item) => item.id !== conversation.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action impossible.');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Conversations masquées' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.four }}>
        {conversations.length === 0 && !loading ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
            Aucune conversation masquée. Masque une discussion depuis ses réglages pour la
            retrouver ici.
          </ThemedText>
        ) : (
          <ThemedView style={styles.group}>
            {conversations.map((conversation, index) => {
              const title = conversationTitle(conversation, user.id);
              const isGroup = conversation.type === 'GROUP';
              const other = isGroup
                ? undefined
                : conversation.members.find((member) => member.id !== user.id);
              return (
                <Pressable
                  key={conversation.id}
                  onPress={() => void show(conversation)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      borderBottomColor: undefined,
                      borderBottomWidth: index === conversations.length - 1 ? 0 : undefined,
                    },
                    pressed ? { backgroundColor: '#e5e7eb' } : null,
                  ]}>
                  <Avatar
                    name={title}
                    size={40}
                    uri={isGroup ? null : other?.avatarUrl}
                    gender={other?.gender}
                    variant={isGroup ? 'group' : 'user'}
                  />
                  <ThemedText style={styles.rowLabel} numberOfLines={1}>
                    {title}
                  </ThemedText>
                  <ThemedText style={styles.action}>Afficher</ThemedText>
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
  rowLabel: { flex: 1, fontSize: 16 },
  action: { color: '#3c87f7', fontWeight: '600' },
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
