import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
  useWindowDimensions,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  EMOJI_BY_KEY,
  EMOJI_GROUPS,
  EMOJI_SOURCES,
  type EmojiGroup,
  type EmojiItem,
} from './emojiCatalog';
import { EmojiImage } from './EmojiText';
import { toEmojiKey } from './emojiUtils';
import { buildEmojiSearchIndex, searchEmojiIndex } from './emojiSearch';

export type PanelTheme = {
  panelBg: string;
  tabBg: string;
  tabActiveBg: string;
  text: string;
  subtle: string;
  icon: string;
  border: string;
  pressed: string;
  accent: string;
  accentText: string;
};

const BAR_H = 48; // barre d'onglets en bas
const SEARCH_H = 48; // barre de recherche
const DOTS_H = 20; // points de pagination
const COLS = 8;
const COMPACT_COLS = 7;
const COMPACT_WIDTH = 340;
const CELL_H = 46;
const EMOJI_SIZE = 34;
const COMPACT_EMOJI_SIZE = 30;

type Tab =
  | { id: string; kind: 'recent' }
  | { id: string; kind: 'favorite' }
  | { id: string; kind: 'group'; group: EmojiGroup };

type Props = {
  /** Hauteur totale de la section emojis (hors marge basse de sécurité). */
  height: number;
  recents: string[];
  favorites: string[];
  onPickEmoji: (emoji: string) => void;
  /** Doit lire le texte courant via des refs (appelée en boucle lors d'un appui long). */
  onBackspace: () => void;
  theme: PanelTheme;
  /** Appui long sur un emoji : ajoute/retire des favoris. */
  onToggleFavorite?: (emoji: string) => void;
  /** La barre de recherche prend le clavier : le compositeur garde le panneau ouvert. */
  onSearchFocusChange?: (focused: boolean) => void;
};

/* ------------------------------ Pagination ------------------------------ */

type PagerProps<T> = {
  items: T[];
  perPage: number;
  width: number;
  height: number;
  theme: PanelTheme;
  renderPage: (pageItems: T[]) => React.ReactElement;
};

function Pager<T>({ items, perPage, width, height, theme, renderPage }: PagerProps<T>) {
  const pages = useMemo(() => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += perPage) out.push(items.slice(i, i + perPage));
    return out.length ? out : [[] as T[]];
  }, [items, perPage]);
  const [page, setPage] = useState(0);

  const onEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setPage(Math.round(e.nativeEvent.contentOffset.x / width));
    },
    [width],
  );

  const listHeight = height - DOTS_H;
  return (
    <View style={{ height }}>
      <FlatList
        horizontal
        pagingEnabled
        data={pages}
        style={{ height: listHeight, flexGrow: 0 }}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <View style={{ width, height: listHeight }}>{renderPage(item)}</View>}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onEnd}
        initialNumToRender={1}
        windowSize={3}
      />
      <View style={styles.dots}>
        {pages.length > 1 &&
          pages.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                { backgroundColor: theme.text, opacity: i === page ? 0.75 : 0.25 },
              ]}
            />
          ))}
      </View>
    </View>
  );
}

/* ------------------------------ Emoji ------------------------------ */

type BackspaceProps = { onBackspace: () => void; width: number; theme: PanelTheme };

/** Touche « effacer » : un appui efface un caractère, un appui long répète. */
const BackspaceCell = memo(function BackspaceCell({ onBackspace, width, theme }: BackspaceProps) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Effacer"
      onPress={onBackspace}
      delayLongPress={350}
      onLongPress={() => {
        stop();
        timer.current = setInterval(onBackspace, 70);
      }}
      onPressOut={stop}
      style={({ pressed }) => [
        styles.cell,
        { width, height: CELL_H },
        pressed && { backgroundColor: theme.pressed, borderRadius: 8 },
      ]}
    >
      <MaterialCommunityIcons name="backspace-outline" size={26} color={theme.icon} />
    </Pressable>
  );
});

type EmojiPageProps = {
  items: EmojiItem[];
  cellW: number;
  cols: number;
  emojiSize: number;
  rows: number;
  showBackspace: boolean;
  favorites: Set<string>;
  onPick: (emoji: string) => void;
  onBackspace: () => void;
  onLongPress?: (emoji: EmojiItem) => void;
  theme: PanelTheme;
};

const EmojiPage = memo(function EmojiPage({
  items,
  cellW,
  cols,
  emojiSize,
  rows,
  showBackspace,
  favorites,
  onPick,
  onBackspace,
  onLongPress,
  theme,
}: EmojiPageProps) {
  return (
    <View style={{ height: rows * CELL_H }}>
      {Array.from({ length: rows }, (_, rowIndex) => {
        const rowItems = items.slice(rowIndex * cols, (rowIndex + 1) * cols);
        return (
          <View key={rowIndex} style={{ flexDirection: 'row', height: CELL_H }}>
            {rowItems.map((emoji) => (
              <Pressable
                key={emoji.key}
                onPress={() => onPick(emoji.char)}
                onLongPress={onLongPress ? () => onLongPress(emoji) : undefined}
                delayLongPress={350}
                accessibilityLabel={emoji.name}
                style={({ pressed }) => [
                  styles.cell,
                  { width: `${100 / cols}%`, height: CELL_H },
                  pressed && { backgroundColor: theme.pressed, borderRadius: 8 },
                ]}
              >
                {EMOJI_SOURCES[emoji.key] ? (
                  <EmojiImage emojiKey={emoji.key} size={emojiSize} />
                ) : (
                  <Text
                    numberOfLines={1}
                    allowFontScaling={false}
                    style={[
                      styles.nativeEmoji,
                      { fontSize: Math.round(emojiSize * 0.9), lineHeight: CELL_H },
                    ]}
                  >
                    {emoji.char}
                  </Text>
                )}
                {favorites.has(emoji.key) ? (
                  <MaterialCommunityIcons
                    name="star"
                    size={10}
                    color={theme.accent}
                    style={styles.favoriteStar}
                  />
                ) : null}
              </Pressable>
            ))}
          </View>
        );
      })}
      {showBackspace ? (
        <View
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: `${100 / cols}%`,
          }}>
          <BackspaceCell onBackspace={onBackspace} width={cellW} theme={theme} />
        </View>
      ) : null}
    </View>
  );
});

/* ------------------------------ Panneau ------------------------------ */

export function EmojiPanel({
  height,
  recents,
  favorites,
  onPickEmoji,
  onBackspace,
  theme,
  onToggleFavorite,
  onSearchFocusChange,
}: Props) {
  const { width } = useWindowDimensions();
  const compact = width < COMPACT_WIDTH;
  const cols = compact ? COMPACT_COLS : COLS;
  const emojiSize = compact ? COMPACT_EMOJI_SIZE : EMOJI_SIZE;
  const cellW = width / cols;

  const searchRef = useRef<TextInputInstance>(null);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const searchIndex = useMemo(() => buildEmojiSearchIndex(EMOJI_GROUPS), []);
  const searchResults = useMemo(
    () => (query.trim() ? searchEmojiIndex(searchIndex, query) : null),
    [searchIndex, query],
  );
  const searching = searchResults !== null;
  const favoritesSet = useMemo(() => new Set(favorites.map((char) => toEmojiKey(char))), [favorites]);

  const tabs = useMemo<Tab[]>(
    () => [
      { id: 'recent', kind: 'recent' },
      { id: 'favorite', kind: 'favorite' },
      ...EMOJI_GROUPS.map((group) => ({ id: group.id, kind: 'group' as const, group })),
    ],
    [],
  );

  const [tabId, setTabId] = useState<string>(() =>
    recents.length ? 'recent' : favorites.length ? 'favorite' : EMOJI_GROUPS[0]?.id ?? 'recent',
  );
  const tab = tabs.find((entry) => entry.id === tabId) ?? tabs[0];

  // Pendant la recherche, les onglets sont masqués pour laisser de la place aux résultats.
  const showBar = !searchFocused;
  const mainHeight = Math.max(80, height - SEARCH_H - (showBar ? BAR_H : 0));
  const gridHeight = mainHeight - DOTS_H;
  const rows = Math.max(1, Math.floor(gridHeight / CELL_H));
  const emojiPerPage = cols * rows - 1; // -1 : la case « effacer »
  const searchPerPage = cols * rows;

  const recentItems = useMemo(
    () => recents.map((char) => EMOJI_BY_KEY.get(toEmojiKey(char))).filter((e): e is EmojiItem => !!e),
    [recents],
  );
  const favoriteItems = useMemo(
    () => favorites.map((char) => EMOJI_BY_KEY.get(toEmojiKey(char))).filter((e): e is EmojiItem => !!e),
    [favorites],
  );

  const handleLongPress = useCallback(
    (emoji: EmojiItem) => {
      if (!onToggleFavorite) return;
      Haptics.selectionAsync().catch(() => {});
      onToggleFavorite(emoji.char);
    },
    [onToggleFavorite],
  );

  const handleSearchFocus = useCallback(() => {
    setSearchFocused(true);
    onSearchFocusChange?.(true);
  }, [onSearchFocusChange]);

  const handleSearchBlur = useCallback(() => {
    setSearchFocused(false);
    onSearchFocusChange?.(false);
  }, [onSearchFocusChange]);

  const selectTab = useCallback((nextTabId: string) => {
    setQuery('');
    setTabId(nextTabId);
    searchRef.current?.blur();
  }, []);

  let content: React.ReactElement;
  if (searching) {
    content =
      searchResults.length === 0 ? (
        <View style={[styles.empty, { height: mainHeight }]}>
          <Text style={{ color: theme.subtle }}>Aucun emoji trouvé</Text>
        </View>
      ) : (
        <Pager
          key={`search:${query}`}
          items={searchResults}
          perPage={searchPerPage}
          width={width}
          height={mainHeight}
          theme={theme}
          renderPage={(page) => (
            <EmojiPage
              items={page}
              cellW={cellW}
              cols={cols}
              emojiSize={emojiSize}
              rows={rows}
              showBackspace={false}
              favorites={favoritesSet}
              onPick={onPickEmoji}
              onBackspace={onBackspace}
              onLongPress={handleLongPress}
              theme={theme}
            />
          )}
        />
      );
  } else {
    const items =
      tab.kind === 'recent'
        ? recentItems
        : tab.kind === 'favorite'
          ? favoriteItems
          : tab.group.emojis;
    const emptyLabel =
      tab.kind === 'recent'
        ? 'Aucun emoji récent'
        : tab.kind === 'favorite'
          ? 'Aucun favori — appui long sur un emoji'
          : 'Aucun emoji';
    content =
      items.length === 0 ? (
        <View style={[styles.empty, { height: mainHeight }]}>
          <Text style={{ color: theme.subtle }}>{emptyLabel}</Text>
        </View>
      ) : (
        <Pager
          key={tab.id}
          items={items}
          perPage={emojiPerPage}
          width={width}
          height={mainHeight}
          theme={theme}
          renderPage={(page) => (
            <EmojiPage
              items={page}
              cellW={cellW}
              cols={cols}
              emojiSize={emojiSize}
              rows={rows}
              showBackspace
              favorites={favoritesSet}
              onPick={onPickEmoji}
              onBackspace={onBackspace}
              onLongPress={handleLongPress}
              theme={theme}
            />
          )}
        />
      );
  }

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
          placeholder="Rechercher un emoji"
          placeholderTextColor={theme.subtle}
          style={[styles.searchInput, { color: theme.text }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onFocus={handleSearchFocus}
          onBlur={handleSearchBlur}
          accessibilityLabel="Rechercher un emoji"
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
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Quitter la recherche">
            <MaterialCommunityIcons name="chevron-left" size={20} color={theme.subtle} />
          </Pressable>
        ) : null}
      </View>

      {content}

      {showBar ? (
        <View style={[styles.bar, { height: BAR_H, borderTopColor: theme.border, backgroundColor: theme.panelBg }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
          {tabs.map((entry) => {
            const active = !searching && entry.id === tab.id;
            return (
              <Pressable
                key={entry.id}
                onPress={() => selectTab(entry.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={
                  entry.kind === 'recent'
                    ? 'Emoji récents'
                    : entry.kind === 'favorite'
                      ? 'Emoji favoris'
                      : entry.group.label
                }
                style={[styles.tab, { backgroundColor: active ? theme.tabActiveBg : 'transparent' }]}
              >
                {entry.kind === 'recent' ? (
                  <MaterialCommunityIcons name="clock-outline" size={24} color={theme.icon} />
                ) : entry.kind === 'favorite' ? (
                  <MaterialCommunityIcons
                    name={favorites.length ? 'star' : 'star-outline'}
                    size={24}
                    color={theme.icon}
                  />
                ) : EMOJI_SOURCES[entry.group.iconKey] ? (
                  <EmojiImage emojiKey={entry.group.iconKey} size={24} />
                ) : (
                  <Text
                    numberOfLines={1}
                    allowFontScaling={false}
                    style={{ fontSize: 20, lineHeight: 24 }}>
                    {entry.group.iconChar ?? entry.group.emojis[0]?.char ?? '🙂'}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { alignItems: 'center', justifyContent: 'center', position: 'relative' },
  nativeEmoji: { textAlign: 'center' },
  favoriteStar: { position: 'absolute', top: 1, right: 3 },
  dots: { height: DOTS_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  searchBar: {
    height: 40,
    marginHorizontal: 8,
    marginTop: 4,
    marginBottom: 4,
    paddingHorizontal: 10,
    borderRadius: 10,
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
  bar: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingRight: 8 },
  tabs: { paddingHorizontal: 8, alignItems: 'center', gap: 4 },
  tab: { width: 44, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
