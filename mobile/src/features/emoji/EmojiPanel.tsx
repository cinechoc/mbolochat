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
import { Radii } from '@/constants/theme';

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
const COLS = 8;
const COMPACT_COLS = 7;
const COMPACT_WIDTH = 340;
const CELL_H = 46;
const EMOJI_SIZE = 34;
const COMPACT_EMOJI_SIZE = 30;
const BACKSPACE_W = 52; // touche « effacer » fixe à droite de la barre

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
        pressed && { backgroundColor: theme.pressed, borderRadius: Radii.sm },
      ]}
    >
      <MaterialCommunityIcons name="backspace-outline" size={26} color={theme.icon} />
    </Pressable>
  );
});

type EmojiGridProps = {
  items: EmojiItem[];
  cols: number;
  emojiSize: number;
  height: number;
  favorites: Set<string>;
  onPick: (emoji: string) => void;
  onLongPress?: (emoji: EmojiItem) => void;
  theme: PanelTheme;
};

/** Grille d'emojis défilant verticalement (comme WhatsApp). */
const EmojiGrid = memo(function EmojiGrid({
  items,
  cols,
  emojiSize,
  height,
  favorites,
  onPick,
  onLongPress,
  theme,
}: EmojiGridProps) {
  const rows = useMemo(() => {
    const out: EmojiItem[][] = [];
    for (let i = 0; i < items.length; i += cols) out.push(items.slice(i, i + cols));
    return out;
  }, [items, cols]);

  return (
    <ScrollView
      style={{ height, flexGrow: 0 }}
      nestedScrollEnabled
      showsVerticalScrollIndicator={false}>
      {rows.map((rowItems, rowIndex) => (
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
                pressed && { backgroundColor: theme.pressed, borderRadius: Radii.sm },
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
      ))}
    </ScrollView>
  );
});

type EmptyPageProps = { height: number; theme: PanelTheme; label: string };

const EmptyPage = memo(function EmptyPage({ height, theme, label }: EmptyPageProps) {
  return (
    <View style={[styles.empty, { height }]}>
      <Text style={{ color: theme.subtle }}>{label}</Text>
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

  const pagerRef = useRef<FlatList<Tab>>(null);

  const [tabId, setTabId] = useState<string>(() =>
    recents.length ? 'recent' : favorites.length ? 'favorite' : EMOJI_GROUPS[0]?.id ?? 'recent',
  );
  const tab = tabs.find((entry) => entry.id === tabId) ?? tabs[0];

  // Pendant la recherche, les onglets sont masqués pour laisser de la place aux résultats.
  const showBar = !searchFocused;
  const mainHeight = Math.max(80, height - SEARCH_H - (showBar ? BAR_H : 0));

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

  /** Fin d'un glissement horizontal : l'onglet actif suit la page affichée. */
  const handleScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(e.nativeEvent.contentOffset.x / width);
      const next = tabs[index];
      if (next && next.id !== tabId) setTabId(next.id);
    },
    [width, tabs, tabId],
  );

  /** Appui sur un onglet : saute directement à la catégorie correspondante. */
  const selectTab = useCallback(
    (nextTabId: string) => {
      setQuery('');
      searchRef.current?.blur();
      setTabId(nextTabId);
      const index = tabs.findIndex((entry) => entry.id === nextTabId);
      // scrollToIndex animé : un saut instantané (animated:false) laisse la fenêtre
      // de rendu du FlatList sur l'ancienne page — la page cible s'affiche vide.
      if (index >= 0) pagerRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
    },
    [tabs, width],
  );

  // Si l'onglet initial n'est pas la première page, placer le pager dessus au montage.
  useEffect(() => {
    const index = tabs.findIndex((entry) => entry.id === tabId);
    if (index > 0) pagerRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let content: React.ReactElement;
  if (searching) {
    content =
      searchResults.length === 0 ? (
        <EmptyPage height={mainHeight} theme={theme} label="Aucun emoji trouvé" />
      ) : (
        <EmojiGrid
          key={`search:${query}`}
          items={searchResults}
          cols={cols}
          emojiSize={emojiSize}
          height={mainHeight}
          favorites={favoritesSet}
          onPick={onPickEmoji}
          onLongPress={handleLongPress}
          theme={theme}
        />
      );
  } else {
    // Un pager horizontal « page = catégorie » ; chaque page défile verticalement
    // et la barre d'onglets se synchronise, comme WhatsApp.
    content = (
      <FlatList
        ref={pagerRef}
        horizontal
        pagingEnabled
        data={tabs}
        style={{ flexGrow: 0 }}
        keyExtractor={(entry) => entry.id}
        renderItem={({ item }) => {
          const items =
            item.kind === 'recent'
              ? recentItems
              : item.kind === 'favorite'
                ? favoriteItems
                : item.group.emojis;
          const emptyLabel =
            item.kind === 'recent'
              ? 'Aucun emoji récent'
              : item.kind === 'favorite'
                ? 'Aucun favori — appui long sur un emoji'
                : 'Aucun emoji';
          return (
            <View style={{ width, height: mainHeight }}>
              {items.length ? (
                <EmojiGrid
                  items={items}
                  cols={cols}
                  emojiSize={emojiSize}
                  height={mainHeight}
                  favorites={favoritesSet}
                  onPick={onPickEmoji}
                  onLongPress={handleLongPress}
                  theme={theme}
                />
              ) : (
                <EmptyPage height={mainHeight} theme={theme} label={emptyLabel} />
              )}
            </View>
          );
        }}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        showsHorizontalScrollIndicator={false}
        initialNumToRender={1}
        windowSize={3}
        onMomentumScrollEnd={handleScrollEnd}
        onScrollEndDrag={handleScrollEnd}
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
          placeholder="Rechercher un emoji Mbolo"
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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} style={{ flex: 1 }}>
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
        <View style={styles.backspaceSlot}>
          <BackspaceCell onBackspace={onBackspace} width={BACKSPACE_W} theme={theme} />
        </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { alignItems: 'center', justifyContent: 'center', position: 'relative' },
  nativeEmoji: { textAlign: 'center' },
  favoriteStar: { position: 'absolute', top: 1, right: 3 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
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
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingRight: 4,
  },
  tabs: { paddingHorizontal: 8, alignItems: 'center', gap: 4 },
  tab: { width: 44, height: 34, borderRadius: Radii.sm, alignItems: 'center', justifyContent: 'center' },
  backspaceSlot: { justifyContent: 'center', paddingRight: 4 },
});
