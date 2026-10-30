import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import type { ConversationSummary } from '@/lib/types';

/**
 * Préférences d'une discussion directe. Les groupes ont leur propre écran
 * (`/group/[id]`) : ce fichier ne sert plus qu'aux têtes-à-tête.
 */
export default function ConversationSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, user } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const [conversation, setConversation] = useState<ConversationSummary | null>(() =>
    id ? cache.getConversation(id) : null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const c = await api.getConversation(token, id);
      setConversation(c);
      cache.setConversation(c);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger.');
    }
  }, [token, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  if (conversation?.type === 'GROUP') {
    return <Redirect href={{ pathname: '/group/[id]', params: { id: conversation.id } }} />;
  }

  const updatePreference = (patch: { hidden?: boolean; muted?: boolean; pinned?: boolean }) => {
    if (!token || !id) return;
    void api
      .setConversationPreferences(token, id, patch)
      .then((updated) => {
        setConversation(updated);
        cache.setConversation(updated);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Action impossible.'),
      );
  };

  if (!conversation) {
    return <ThemedView style={styles.container} />;
  }

  return (
    <ThemedView style={styles.container}>
      {error ? (
        <ThemedText type="small" style={{ color: theme.error }}>
          {error}
        </ThemedText>
      ) : null}

      <ThemedView style={styles.section}>
        <ThemedText type="smallBold">Préférences</ThemedText>
        <PreferenceRow
          label="Épingler en haut"
          hint="La discussion reste en tête de la liste."
          value={conversation.pinned}
          onChange={(value) => updatePreference({ pinned: value })}
        />
        <PreferenceRow
          label="Notifications muettes"
          hint="Aucun badge ni son pour cette discussion."
          value={conversation.muted}
          onChange={(value) => updatePreference({ muted: value })}
        />
        <PreferenceRow
          label="Masquer la discussion"
          hint="Elle disparaît de ta liste. Tu la retrouveras dans Paramètres › Confidentialité › Conversations masquées."
          value={conversation.hidden}
          onChange={(value) => updatePreference({ hidden: value })}
        />
      </ThemedView>

      <View style={styles.footer}>
        <Button title="Fermer" variant="secondary" onPress={() => router.back()} />
      </View>
    </ThemedView>
  );
}

function PreferenceRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <ThemedText>{label}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {hint}
        </ThemedText>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: accentColor, false: theme.backgroundElement }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: Spacing.three, gap: Spacing.three },
  section: { gap: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  rowBody: { flex: 1, gap: Spacing.half },
  footer: { marginTop: 'auto' },
});
