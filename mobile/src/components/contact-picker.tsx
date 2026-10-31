import { Check, Search, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { TextField } from '@/components/ui';
import { Radii, Spacing } from '@/constants/theme';
import { useBottomInset } from '@/hooks/use-bottom-inset';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { User } from '@/lib/types';

type Row =
  | { key: string; type: 'label'; label: string }
  | { key: string; type: 'user'; user: User };

interface ContactPickerProps {
  selected: User[];
  onToggle: (user: User) => void;
  /** Comptes à masquer (déjà membres, par exemple). */
  excludeIds?: string[];
  /** Plafond de sélection : les lignes non cochées sont désactivées au-delà. */
  max?: number;
  autoFocus?: boolean;
  placeholder?: string;
}

/**
 * Sélecteur de contacts unique de l'app : suggestions (récents puis
 * alphabétique), recherche, puces de sélection. Utilisé pour un message privé
 * comme pour un groupe.
 */
export function ContactPicker({
  selected,
  onToggle,
  excludeIds,
  max,
  autoFocus = false,
  placeholder = 'Rechercher un pseudo ou un nom',
}: ContactPickerProps) {
  const { token } = useAuth();
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const bottomInset = useBottomInset();
  const [recent, setRecent] = useState<User[]>([]);
  const [contacts, setContacts] = useState<User[]>([]);
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchActive = query.trim().length > 0;
  const excluded = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);
  const selectedIds = useMemo(() => new Set(selected.map((user) => user.id)), [selected]);
  const limitReached = max !== undefined && selected.length >= max;

  useEffect(() => {
    if (!token) return;
    let active = true;
    api
      .suggestContacts(token)
      .then((result) => {
        if (!active) return;
        setRecent(result.recent);
        setContacts(result.contacts);
      })
      .catch(() => {
        // Les suggestions sont un confort : la recherche reste utilisable.
      });
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token || query.trim().length === 0) {
      return;
    }
    let active = true;
    const timeout = setTimeout(() => {
      if (!active) return;
      setSearching(true);
      api
        .searchUsers(token, query.trim())
        .then((users) => {
          if (active) {
            setResults(users);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (active) {
            setError(
              err instanceof ApiError ? err.message : 'Recherche impossible pour le moment.',
            );
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [token, query]);

  const rows = useMemo<Row[]>(() => {
    const visible = (user: User) => !excluded.has(user.id);
    if (query.trim().length > 0) {
      return results
        .filter(visible)
        .map((user) => ({ key: user.id, type: 'user' as const, user }));
    }
    const list: Row[] = [];
    const recentVisible = recent.filter(visible);
    if (recentVisible.length > 0) {
      list.push({ key: 'label:recent', type: 'label', label: 'Récents' });
      for (const user of recentVisible) {
        list.push({ key: user.id, type: 'user', user });
      }
    }
    const contactVisible = contacts.filter(
      (user) => visible(user) && !recentVisible.some((entry) => entry.id === user.id),
    );
    if (contactVisible.length > 0) {
      list.push({ key: 'label:contacts', type: 'label', label: 'Contacts' });
      for (const user of contactVisible) {
        list.push({ key: user.id, type: 'user', user });
      }
    }
    return list;
  }, [query, results, recent, contacts, excluded]);

  const emptyHint =
    query.trim().length > 0
      ? `Aucun résultat pour « ${query.trim()} ».`
      : 'Aucun contact pour l’instant. Recherche un pseudo pour commencer.';

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <Search size={18} color={theme.textSecondary} />
        <TextField
          style={styles.search}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={autoFocus}
          value={query}
          onChangeText={setQuery}
          accessibilityLabel="Rechercher un contact"
        />
        {searching && searchActive ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : null}
      </View>

      {selected.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          keyboardShouldPersistTaps="handled">
          {selected.map((user) => (
            <Animated.View key={user.id} entering={ZoomIn.duration(150)}>
              <Pressable
                onPress={() => onToggle(user)}
                accessibilityRole="button"
                accessibilityLabel={`Retirer ${user.displayName}`}
                style={[styles.chip, { backgroundColor: theme.accentSoft }]}>
                <Avatar name={user.displayName} uri={user.avatarUrl} gender={user.gender} size={24} />
                <ThemedText type="small" numberOfLines={1} style={styles.chipName}>
                  {user.displayName}
                </ThemedText>
                <X size={14} color={theme.textSecondary} />
              </Pressable>
            </Animated.View>
          ))}
        </ScrollView>
      ) : null}

      {error ? (
        <ThemedText type="small" style={[styles.error, { color: theme.danger }]}>
          {error}
        </ThemedText>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          rows.length === 0 ? styles.emptyList : styles.list,
          { paddingBottom: bottomInset + Spacing.three },
        ]}
        ListEmptyComponent={
          <Animated.View entering={FadeIn.duration(200)} style={styles.empty}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>
              {emptyHint}
            </ThemedText>
          </Animated.View>
        }
        renderItem={({ item }) => {
          if (item.type === 'label') {
            return (
              <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
                {item.label}
              </ThemedText>
            );
          }
          const user = item.user;
          const isSelected = selectedIds.has(user.id);
          const disabled = !isSelected && limitReached;
          return (
            <Pressable
              onPress={() => (disabled ? undefined : onToggle(user))}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled }}
              accessibilityLabel={`${user.displayName}, ${isSelected ? 'sélectionné' : 'non sélectionné'}`}
              style={({ pressed }) => [
                styles.row,
                pressed && !disabled && { backgroundColor: theme.backgroundSelected },
                disabled && styles.rowDisabled,
              ]}>
              <Avatar name={user.displayName} uri={user.avatarUrl} gender={user.gender} size={40} />
              <View style={styles.rowBody}>
                <ThemedText numberOfLines={1}>{user.displayName}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                  @{user.username}
                </ThemedText>
              </View>
              <View
                style={[
                  styles.check,
                  {
                    borderColor: isSelected ? theme.accent : theme.border,
                    backgroundColor: isSelected ? theme.accent : 'transparent',
                  },
                ]}>
                {isSelected ? <Check size={14} color={theme.onAccent} strokeWidth={3} /> : null}
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: Spacing.two },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  search: { flex: 1, borderRadius: Radii.md },
  chips: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingLeft: Spacing.one,
    paddingRight: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radii.sm,
    maxWidth: 190,
  },
  chipName: { flexShrink: 1 },
  error: { paddingHorizontal: Spacing.three },
  list: { paddingBottom: Spacing.four },
  emptyList: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.five },
  emptyText: { textAlign: 'center' },
  sectionLabel: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, paddingBottom: Spacing.one },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.threeHalf,
    minHeight: 60,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  rowDisabled: { opacity: 0.4 },
  rowBody: { flex: 1, gap: 1 },
  check: {
    width: 22,
    height: 22,
    borderRadius: Radii.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
