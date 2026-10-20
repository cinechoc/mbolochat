import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { User } from '@/lib/types';

type Mode = 'direct' | 'group';

export default function NewChatScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('direct');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<User[]>([]);
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || query.trim().length === 0) {
      return;
    }
    let active = true;
    const timeout = setTimeout(async () => {
      if (!active) return;
      setSearching(true);
      try {
        const users = await api.searchUsers(token, query.trim());
        if (active) {
          setResults(users);
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof ApiError ? err.message : 'Recherche impossible.');
      } finally {
        if (active) setSearching(false);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [token, query]);

  if (!token) {
    return <Redirect href="/login" />;
  }

  const toggleSelect = (u: User) => {
    setSelected((prev) =>
      prev.some((x) => x.id === u.id) ? prev.filter((x) => x.id !== u.id) : [...prev, u],
    );
  };

  const createDirect = async (other: User) => {
    setCreating(true);
    setError(null);
    try {
      const conversation = await api.createConversation(token, { memberIds: [other.id] });
      router.push({ pathname: '/chat/[id]', params: { id: conversation.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de démarrer la discussion.');
    } finally {
      setCreating(false);
    }
  };

  const createGroup = async () => {
    if (selected.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const conversation = await api.createConversation(token, {
        type: 'GROUP',
        name: groupName.trim() || undefined,
        memberIds: selected.map((u) => u.id),
      });
      router.push({ pathname: '/chat/[id]', params: { id: conversation.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de créer le groupe.');
    } finally {
      setCreating(false);
    }
  };

  const showingResults = query.trim().length > 0;

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.modeRow}>
        <Pressable
          onPress={() => setMode('direct')}
          style={[styles.modeBtn, mode === 'direct' && { backgroundColor: accentColor }]}>
          <ThemedText style={mode === 'direct' ? styles.modeTextActive : undefined}>Discussion</ThemedText>
        </Pressable>
        <Pressable
          onPress={() => setMode('group')}
          style={[styles.modeBtn, mode === 'group' && { backgroundColor: accentColor }]}>
          <ThemedText style={mode === 'group' ? styles.modeTextActive : undefined}>Groupe</ThemedText>
        </Pressable>
      </ThemedView>

      {mode === 'group' ? (
        <ThemedView style={styles.groupHeader}>
          <TextField
            style={styles.search}
            placeholder="Nom du groupe (optionnel)"
            value={groupName}
            onChangeText={setGroupName}
          />
          {selected.length > 0 ? (
            <ThemedView style={styles.selectedRow}>
              {selected.map((u) => (
                <Pressable key={u.id} onPress={() => toggleSelect(u)} style={styles.chip}>
                  <ThemedText type="small">{u.displayName} ✕</ThemedText>
                </Pressable>
              ))}
            </ThemedView>
          ) : null}
        </ThemedView>
      ) : null}

      <ThemedView style={styles.searchBox}>
        <TextField
          style={styles.search}
          placeholder="Rechercher par pseudo ou nom..."
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          value={query}
          onChangeText={setQuery}
        />
      </ThemedView>

      {error ? (
        <ThemedText type="small" style={styles.error}>
          {error}
        </ThemedText>
      ) : null}

      {showingResults && searching && results.length === 0 ? (
        <ThemedView style={styles.center}>
          <ActivityIndicator />
        </ThemedView>
      ) : (
        <FlatList
          data={showingResults ? results : []}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.backgroundElement }]} />
          )}
          ListEmptyComponent={
            <ThemedView style={styles.center}>
              <ThemedText themeColor="textSecondary" style={styles.hint}>
                {query.trim().length === 0
                  ? 'Tape un pseudo pour trouver quelqu’un.'
                  : 'Aucun utilisateur trouvé.'}
              </ThemedText>
            </ThemedView>
          }
          renderItem={({ item }) => {
            const isSelected = selected.some((x) => x.id === item.id);
            return (
              <Pressable
                onPress={() => (mode === 'group' ? toggleSelect(item) : createDirect(item))}
                disabled={creating}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? theme.backgroundSelected : theme.background },
                ]}>
                <Pressable
                  onPress={() => router.push({ pathname: '/user/[id]', params: { id: item.id } })}
                  hitSlop={6}>
                  <Avatar name={item.displayName} size={48} uri={item.avatarUrl} />
                </Pressable>
                <View style={styles.rowBody}>
                  <ThemedText style={styles.rowTitle}>{item.displayName}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    @{item.username}
                  </ThemedText>
                </View>
                {mode === 'group' ? (
                  <ThemedText style={isSelected ? styles.checkOn : styles.checkOff}>
                    {isSelected ? '✓' : '○'}
                  </ThemedText>
                ) : creating ? (
                  <ActivityIndicator />
                ) : (
                  <ThemedText themeColor="textSecondary" style={styles.chevron}>
                    ›
                  </ThemedText>
                )}
              </Pressable>
            );
          }}
        />
      )}

      {mode === 'group' && selected.length > 0 ? (
        <ThemedView style={styles.footer}>
          <Button title={`Créer le groupe (${selected.length})`} onPress={createGroup} loading={creating} />
        </ThemedView>
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  modeRow: { flexDirection: 'row', padding: Spacing.three, gap: Spacing.two },
  modeBtn: {
    flex: 1,
    paddingVertical: Spacing.two,
    borderRadius: 22,
    alignItems: 'center',
    backgroundColor: '#e6e6e6',
  },
  modeTextActive: { color: '#ffffff', fontWeight: '600' },
  groupHeader: { paddingHorizontal: Spacing.three, gap: Spacing.two, paddingBottom: Spacing.two },
  selectedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  chip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: 999,
    backgroundColor: '#e6e6e6',
  },
  searchBox: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.two },
  search: { borderRadius: 22, paddingVertical: Spacing.two },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.five },
  hint: { textAlign: 'center' },
  error: { color: '#e5484d', paddingHorizontal: Spacing.three },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    gap: Spacing.three,
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 80 },
  chevron: { fontSize: 24, lineHeight: 24 },
  rowBody: { flex: 1, gap: Spacing.half },
  rowTitle: { fontWeight: '600' },
  checkOn: { color: accentColor, fontSize: 20, fontWeight: '700' },
  checkOff: { color: '#999', fontSize: 20 },
  footer: { padding: Spacing.three },
});