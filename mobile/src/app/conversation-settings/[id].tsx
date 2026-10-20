import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Switch, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { SkeletonRows } from '@/components/skeleton';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { ConversationSummary, User } from '@/lib/types';

export default function ConversationSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, user } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const c = await api.getConversation(token, id);
      setConversation(c);
      setName(c.name ?? '');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger.');
    } finally {
      setLoading(false);
    }
  }, [token, id]);

  useEffect(() => {
    const run = async () => { await load(); };
    void run();
  }, [load]);

  useEffect(() => {
    if (!token || query.trim().length === 0) return;
    let active = true;
    const t = setTimeout(async () => {
      if (!active) return;
      setSearching(true);
      try {
        const users = await api.searchUsers(token, query.trim());
        if (active) setResults(users.filter((u) => !conversation?.members.some((m) => m.id === u.id)));
      } catch {
        // ignore
      } finally {
        if (active) setSearching(false);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [token, query, conversation]);

  if (!token || !user) return <Redirect href="/login" />;

  const rename = async () => {
    if (!token || !id) return;
    setSavingName(true);
    try {
      const c = await api.renameConversation(token, id, name);
      setConversation(c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Renommage impossible.');
    } finally {
      setSavingName(false);
    }
  };

  const addMember = async (u: User) => {
    if (!token || !id) return;
    setAdding(u.id);
    try {
      const c = await api.addConversationMembers(token, id, [u.id]);
      setConversation(c);
      setQuery('');
      setResults([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ajout impossible.');
    } finally {
      setAdding(null);
    }
  };

  const removeMember = async (memberId: string) => {
    if (!token || !id) return;
    try {
      await api.removeConversationMember(token, id, memberId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retrait impossible.');
    }
  };

  if (loading) {
    return (
      <ThemedView style={styles.container}>
        <SkeletonRows count={4} avatarSize={40} />
      </ThemedView>
    );
  }

  const isGroup = conversation?.type === 'GROUP';

  return (
    <ThemedView style={styles.container}>
      {error ? (
        <ThemedText type="small" style={styles.error}>
          {error}
        </ThemedText>
      ) : null}

      {isGroup ? (
        <ThemedView style={styles.section}>
          <ThemedText type="smallBold">Nom du groupe</ThemedText>
          <ThemedView style={styles.row}>
            <TextField style={styles.input} value={name} onChangeText={setName} />
            <Button title="OK" onPress={rename} loading={savingName} />
          </ThemedView>
        </ThemedView>
      ) : null}

      <ThemedView style={styles.section}>
        <ThemedText type="smallBold">Masquer la discussion</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          La discussion disparaît de ta liste. Tu la retrouveras dans Paramètres › Confidentialité ›
          Conversations masquées.
        </ThemedText>
        <View style={styles.switchRow}>
          <ThemedText>{conversation?.hidden ? 'Masquée' : 'Visible'}</ThemedText>
          <Switch
            value={Boolean(conversation?.hidden)}
            onValueChange={(value) => {
              if (!token || !id) return;
              void api
                .setConversationPreferences(token, id, { hidden: value })
                .then((updated) => setConversation(updated))
                .catch((err: unknown) =>
                  setError(
                    err instanceof ApiError ? err.message : 'Action impossible.',
                  ),
                );
            }}
            trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
          />
        </View>
      </ThemedView>

      <ThemedView style={styles.section}>
        <ThemedText type="smallBold">Membres ({conversation?.members.length ?? 0})</ThemedText>
        <FlatList
          data={conversation?.members ?? []}
          keyExtractor={(m) => m.id}
          renderItem={({ item: m }) => (
            <ThemedView style={styles.memberRow}>
              <Avatar name={m.displayName} uri={m.avatarUrl} size={40} />
              <ThemedView style={styles.memberBody}>
                <ThemedText style={styles.memberName}>{m.displayName}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  @{m.username}
                </ThemedText>
              </ThemedView>
              {m.id !== user.id ? (
                <Pressable onPress={() => removeMember(m.id)}>
                  <ThemedText style={styles.danger}>Retirer</ThemedText>
                </Pressable>
              ) : null}
            </ThemedView>
          )}
        />
      </ThemedView>

      <ThemedView style={styles.section}>
        <ThemedText type="smallBold">Ajouter un membre</ThemedText>
        <TextField
          style={styles.search}
          placeholder="Rechercher..."
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searching ? <ActivityIndicator /> : null}
        <FlatList
          data={results}
          keyExtractor={(u) => u.id}
          renderItem={({ item: u }) => (
            <Pressable
              onPress={() => addMember(u)}
              disabled={adding !== null}
              style={({ pressed }) => [styles.resultRow, pressed && { opacity: 0.6 }]}>
              <Avatar name={u.displayName} uri={u.avatarUrl} size={36} />
              <ThemedView style={styles.memberBody}>
                <ThemedText>{u.displayName}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  @{u.username}
                </ThemedText>
              </ThemedView>
              {adding === u.id ? <ActivityIndicator /> : <ThemedText style={{ color: accentColor }}>+</ThemedText>}
            </Pressable>
          )}
        />
      </ThemedView>

      <ThemedView style={styles.footer}>
        <Button title="Fermer" variant="secondary" onPress={() => router.back()} />
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: Spacing.three, gap: Spacing.three },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  section: { gap: Spacing.two },
  row: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center' },
  input: { flex: 1 },
  search: {},
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.one },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.one,
  },
  memberBody: { flex: 1, gap: 2 },
  memberName: { fontWeight: '600' },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.one },
  danger: { color: '#e5484d', fontWeight: '600' },
  error: { color: '#e5484d' },
  footer: { marginTop: 'auto' },
});