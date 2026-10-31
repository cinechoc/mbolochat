import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
  useWindowDimensions,
} from 'react-native';

import type { PanelTheme } from '../emoji/EmojiPanel';
import { Radii } from '@/constants/theme';

/** Un GIF déjà présent dans la conversation et réutilisable tel quel. */
export interface RecentGif {
  id: string;
  url: string;
  stillUrl?: string;
  width?: number;
  height?: number;
  sticker: boolean;
  title?: string;
  giphyId?: string;
  username?: string;
}

type Props = {
  height: number;
  theme: PanelTheme;
  items: RecentGif[];
  onSend: (gif: RecentGif) => void;
  onSearchFocusChange?: (focused: boolean) => void;
};

const SEARCH_H = 48;
const COLUMNS = 3;

export function GifPanel({ height, theme, items, onSend, onSearchFocusChange }: Props) {
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<TextInputInstance>(null);
  const cellSize = (width - 12) / COLUMNS;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.title ?? ''} ${item.username ?? ''}`.toLowerCase().includes(needle),
    );
  }, [items, query]);

  const handleSearchFocus = useCallback(() => {
    setSearchFocused(true);
    onSearchFocusChange?.(true);
  }, [onSearchFocusChange]);

  const handleSearchBlur = useCallback(() => {
    setSearchFocused(false);
    onSearchFocusChange?.(false);
  }, [onSearchFocusChange]);

  return (
    <View style={{ height, backgroundColor: theme.panelBg }}>
      <View
        style={[
          styles.searchBar,
          {
            backgroundColor: theme.tabBg,
            borderColor: searchFocused ? theme.accent : theme.border,
          },
        ]}>
        <MaterialCommunityIcons name="magnify" size={18} color={theme.subtle} />
        <TextInput
          ref={searchRef}
          value={query}
          onChangeText={setQuery}
          placeholder="Rechercher un GIF"
          placeholderTextColor={theme.subtle}
          style={[styles.searchInput, { color: theme.text }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onFocus={handleSearchFocus}
          onBlur={handleSearchBlur}
          accessibilityLabel="Rechercher un GIF"
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Effacer la recherche">
            <MaterialCommunityIcons name="close-circle" size={18} color={theme.subtle} />
          </Pressable>
        ) : null}
        {searchFocused ? (
          <Pressable
            onPress={() => {
              setQuery('');
              searchRef.current?.blur();
              onSearchFocusChange?.(false);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Quitter la recherche">
            <MaterialCommunityIcons name="chevron-left" size={20} color={theme.subtle} />
          </Pressable>
        ) : null}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        numColumns={COLUMNS}
        style={{ height: Math.max(80, height - SEARCH_H) }}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={
          <View style={styles.empty}>
            <MaterialCommunityIcons name="file-gif-box" size={34} color={theme.subtle} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>Aucun GIF réutilisable</Text>
            <Text style={[styles.emptyHint, { color: theme.subtle }]}>
              {items.length === 0
                ? 'Les GIF reçus ou envoyés dans cette conversation apparaîtront ici.'
                : 'Aucun GIF ne correspond à cette recherche.'}
            </Text>
          </View>
        }
        ListFooterComponent={
          items.some((item) => item.giphyId || item.username) ? (
            <Text style={[styles.attribution, { color: theme.subtle }]}>GIF via GIPHY</Text>
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              onSend(item);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Envoyer le GIF ${item.title ?? ''}`.trim()}
            style={({ pressed }) => [
              styles.cell,
              { width: cellSize, height: cellSize },
              pressed && { opacity: 0.65, transform: [{ scale: 0.96 }] },
            ]}>
            <Image
              source={{ uri: item.url }}
              placeholder={item.stillUrl ? { uri: item.stillUrl } : undefined}
              placeholderContentFit="cover"
              style={styles.image}
              contentFit="cover"
              transition={120}
              recyclingKey={item.id}
              cachePolicy="disk"
            />
            <View style={styles.badge}>
              <Text style={styles.badgeText}>GIF</Text>
            </View>
          </Pressable>
        )}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        windowSize={5}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  searchBar: {
    height: 40,
    marginHorizontal: 8,
    marginTop: 4,
    marginBottom: 4,
    paddingHorizontal: 10,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  searchInput: {
    flex: 1,
    height: 38,
    fontSize: 15,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  grid: { paddingHorizontal: 6, paddingBottom: 8 },
  cell: { padding: 3 },
  image: { width: '100%', height: '100%', borderRadius: Radii.sm, backgroundColor: 'rgba(127,127,127,0.12)' },
  badge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    borderRadius: Radii.xs,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  badgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingTop: 40, gap: 8 },
  emptyTitle: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  emptyHint: { fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  attribution: { fontSize: 10.5, textAlign: 'center', paddingVertical: 8, letterSpacing: 0.3 },
});
