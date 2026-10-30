import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ContactPicker } from '@/components/contact-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Gutter, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { User } from '@/lib/types';

/** Nouveau message privé : un seul choix, la conversation s'ouvre aussitôt. */
export default function NewMessageScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return <Redirect href="/login" />;
  }

  const openConversation = async (other: User) => {
    if (creating) return;
    setCreating(other.id);
    setError(null);
    try {
      const conversation = await api.createConversation(token, { memberIds: [other.id] });
      router.replace({ pathname: '/chat/[id]', params: { id: conversation.id } });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Impossible de démarrer la discussion.',
      );
      setCreating(null);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <View style={styles.header}>
        <ThemedText type="screenTitle">Nouveau message</ThemedText>
        <ThemedText type="caption" themeColor="textSecondary">
          {creating
            ? 'Ouverture de la discussion…'
            : 'Choisis une personne à qui écrire.'}
        </ThemedText>
        {error ? (
          <ThemedText type="caption" style={{ color: theme.danger }} accessibilityRole="alert">
            {error}
          </ThemedText>
        ) : null}
      </View>
      <ContactPicker selected={[]} onToggle={(user) => void openConversation(user)} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: Gutter, paddingTop: Spacing.two, gap: Spacing.half },
});
