import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TextField } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { User } from '@/lib/types';

export default function NewChatScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || query.trim().length === 0) {
      return;
    }
    let active = true;
    const timeout = setTimeout(async () => {
      if (!active) {
        return;
      }
      setSearching(true);
      try {
        const users = await api.searchUsers(token, query.trim());
        if (active) {
          setResults(users);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof ApiError ? err.message : 'Recherche impossible.');
        }
      } finally {
        if (active) {
          setSearching(false);
        }
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

  const showingResults = query.trim().length > 0;

  const startConversation = async (other: User) => {
    setCreatingFor(other.id);
    setError(null);
    try {
      const conversation = await api.createConversation(token, { memberIds: [other.id] });
      router.push({ pathname: '/chat/[id]', params: { id: conversation.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de démarrer la discussion.');
    } finally {
      setCreatingFor(null);
    }
  };

  return (
    <ThemedView style={styles.container}>
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
          renderItem={({ item }) => (
            <Pressable
              onPress={() => startConversation(item)}
              disabled={creatingFor !== null}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.backgroundSelected : theme.background },
              ]}>
              <Avatar name={item.displayName} size={48} />
              <ThemedView style={styles.rowBody}>
                <ThemedText style={styles.rowTitle}>{item.displayName}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  @{item.username}
                </ThemedText>
              </ThemedView>
              {creatingFor === item.id ? (
                <ActivityIndicator />
              ) : (
                <ThemedText themeColor="textSecondary" style={styles.chevron}>
                  ›
                </ThemedText>
              )}
            </Pressable>
          )}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchBox: {
    padding: Spacing.three,
    paddingBottom: Spacing.two,
  },
  search: {
    borderRadius: 22,
    paddingVertical: Spacing.two,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  hint: {
    textAlign: 'center',
  },
  error: {
    color: '#e5484d',
    paddingHorizontal: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    gap: Spacing.three,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 80,
  },
  chevron: {
    fontSize: 24,
    lineHeight: 24,
  },
  rowBody: {
    flex: 1,
    gap: Spacing.half,
  },
  rowTitle: {
    fontWeight: '600',
  },
});
